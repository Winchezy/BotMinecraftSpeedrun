const GetWood = require('./tasks/GetWood');
const CraftTask = require('./tasks/CraftTask');
const MineBlock = require('./tasks/MineBlock');
const SmeltTask = require('./tasks/SmeltTask');
const FightMob = require('./tasks/FightMob');
const BuildNetherPortal = require('./tasks/BuildNetherPortal');
const FindStronghold = require('./tasks/FindStronghold');
const FightDragon = require('./tasks/FightDragon');
const MoveToSurface = require('./tasks/MoveToSurface');
const GetFood = require('./tasks/GetFood');
const EscapeCaveLedge = require('./tasks/EscapeCaveLedge');
const FillBucket = require('./tasks/FillBucket');
const MakeObsidian = require('./tasks/MakeObsidian');
const DeathRecovery = require('./lib/DeathRecovery');
const { threatNearPoint } = require('./lib/MobSafety');
const { decideActivity } = require('./lib/SurvivalPolicy');

class Agent {
    constructor(bot) {
        this.bot = bot;
        this.currentTask = null;
        this.suspendedTask = null;
        this.torchLighting = new (require('./lib/TorchLighting'))(bot);
        this.mcData = require('minecraft-data')(bot.version);
        this.stage = 'EARLY_GAME'; // EARLY_GAME, IRON, DIAMOND, NETHER, STRONGHOLD, END
        this.failedTasks = {}; // Echecs CONSECUTIFS par tache (reset au succes de la tache)
        this.lastFailedTask = null; // Derniere tache ayant echoue (pour le disjoncteur)
        this.recoverAttempts = 0;   // Escalade des recuperations du disjoncteur
        this.deathRecovery = new DeathRecovery(bot);
        this.unsafeDigSite = null;
        this.mobRoutePauseUntil = 0;
        this.foodPauseUntil = 0;
        this.waitingForHealth = false;
        this.combatPreparation = new (require('./lib/CombatPreparation'))(bot);
        this.treeEscape = new (require('./lib/TreeEscape'))(bot);

        bot.on('death', () => {
            this.suspendedTask = null;
            this.combatPreparation = new (require('./lib/CombatPreparation'))(bot);
            bot.mobBlockedSince = 0;
            bot.lastMobBlock = 0;
            bot.weaponNeeded = false;
            this.unsafeDigSite = null;
            this.mobRoutePauseUntil = 0;
            this.foodPauseUntil = 0;
            this.waitingForHealth = false;
            this.deathRecovery.onDeath();
            this.currentTask = null;
            try { bot.stopDigging(); } catch (e) { }
            try { bot.pathfinder.stop(); } catch (e) { }
            try { bot.clearControlStates(); } catch (e) { }
        });
        bot.on('spawn', () => this.deathRecovery.onSpawn());

        // Chat Listener for Status Updates
        this.bot.on('chat', (username, message) => {
            if (username === this.bot.username) return;

            const msg = message.toLowerCase();
            if (msg.includes('!status')) {
                const task = this.unsafeDigSite ? 'Descente en pause (grotte)' : (this.currentTask ? this.currentTask.name : 'Idle');
                this.bot.chat(`Health: ${this.bot.health.toFixed(0)}/20 | Food: ${this.bot.food.toFixed(0)}/20 | Task: ${task}`);
            }
            if (msg.includes('!inv') || msg.includes('!inventory')) {
                const items = this.bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ');
                if (items.length === 0) {
                    this.bot.chat("Inventory is empty.");
                } else {
                    // Split into chunks of 240 chars (safe limit for MC chat)
                    const chunks = items.match(/.{1,240}/g) || [];
                    chunks.forEach((chunk, index) => {
                        this.bot.chat(`Inv [${index + 1}/${chunks.length}]: ${chunk}`);
                    });
                }
            }
            if (msg.includes('!pos')) {
                this.bot.chat(`Pos: ${this.bot.entity.position.floored()}`);
            }
        });
    }

    setStage(nextStage) {
        if (this.stage === nextStage) return;
        this.suspendedTask = null;
        const previousStage = this.stage;
        this.stage = nextStage;
        const message = `[SpeedBot] Etape: ${previousStage} -> ${nextStage}`;
        console.log(`[Agent] ${message}`);
        try {
            this.bot.chat(message);
        } catch (error) {
            console.error(`[Agent] Annonce d'etape impossible: ${error.message}`);
        }
    }

    suspendForFood() {
        const task = this.currentTask;
        if (task && !(task instanceof GetFood) && typeof task.isDone === 'function' && !task.isDone()) {
            this.suspendedTask = { task, stage: this.stage };
            console.log(`[Agent] Tache suspendue pour manger : ${task.name}`);
        }
    }

    resumeSuspendedTask() {
        const pending = this.suspendedTask;
        if (!pending || this.currentTask) return false;
        if (pending.stage !== this.stage || pending.task.isDone()) {
            this.suspendedTask = null;
            return false;
        }
        if (this.bot.food <= 10 || this.bot.health < 16 || this.deathRecovery.pending ||
            this.unsafeDigSite || Date.now() < this.mobRoutePauseUntil || this.bot.isInCombat?.()) return false;
        this.currentTask = pending.task;
        this.suspendedTask = null;
        const message = `[SpeedBot] J ai fini de manger : je reprends ${pending.task.name}.`;
        console.log(`[Agent] ${message}`);
        try { this.bot.chat(message); } catch (_) { }
        return true;
    }

    // Pause de chasse active, sauf si on a deja de quoi manger (GetFood mange alors sans chasser).
    foodSearchPaused() {
        if (Date.now() >= this.foodPauseUntil) return false;
        const EDIBLE_HINT = /cooked_|bread|apple|potato|carrot|melon_slice|berries|beetroot|dried_kelp|stew|cookie|pumpkin_pie|^(beef|porkchop|mutton|rabbit|cod|salmon)$/;
        return !this.bot.inventory.items().some(i => EDIBLE_HINT.test(i.name));
    }

    pauseFoodSearch(reason) {
        const now = Date.now();
        const critical = this.bot.food <= 6;
        const delay = critical ? 5000 : 30000;
        this.foodPauseUntil = now + delay;
        this.foodUrgentRetryUntil = now + delay;
        const key = `${reason}:${critical}`;
        if (this.foodNoticeKey === key && now - (this.foodNoticeAt || 0) < 60000) return;
        this.foodNoticeKey = key;
        this.foodNoticeAt = now;
        const message = critical ?
            '[SpeedBot] Faim critique : pas de nourriture accessible. Je poursuis la recherche, nouvel essai dans 5 s.' :
            '[SpeedBot] Pas de nourriture accessible sans risque. Nouvelle recherche dans 30 s.';
        console.log(`[Agent] ${message}`);
        try { this.bot.chat(message); } catch (_) { }
    }

    async tick() {
        const decision = decideActivity(this.bot);
        this.bot.survivalDecision = decision;
        if (decision.activity === 'escape') return;
        if (Date.now() < this.mobRoutePauseUntil) this.combatPreparation.noteBlocked();
        if (this.bot.isClearingObstacle) return;
        if (this.deathRecovery.pending && !this.deathRecovery.ready) return;
        if (this.bot.isInCombat && this.bot.isInCombat()) {
            this.combatPreparation.noteBlocked();
            console.log("[Agent] In Combat! Pausing tasks.");
            return;
        }

        // ===== DANS L'EAU : on laisse Survival gerer SEUL =====
        // Le systeme Survival (physicsTick) gere l'evasion de l'eau en parallele. Si une
        // tache continue a creuser/pathfinder en meme temps, les deux se battent : le dig
        // est annule, le pathfinder est stoppe, et le bot se noie. Tant qu'on est dans
        // l'eau on met donc la tache EN PAUSE (sans la faire echouer) ; elle reprend au sec.
        {
            const p = this.bot.entity.position;
            const feet = this.bot.blockAt(p.floored());
            const head = this.bot.blockAt(p.offset(0, 1.6, 0).floored());
            const inWater = (feet && feet.name.includes('water')) || (head && head.name.includes('water'));
            if (inWater) {
                try { this.bot.stopDigging(); } catch (e) { }
                return; // Survival s'occupe de sortir de l'eau, sans interference.
            }
        }

        if (this.treeEscape?.onTree() && this.bot.canDigBlock) {
            if (this.bot.entity.onGround === false) return;
            if (await this.treeEscape.run()) return;
        }
        if (decision.activity === 'progress' && this.bot.weaponNeeded && await this.combatPreparation.run()) return;
        if (decision.activity === 'regenerate') {
            if (this.currentTask) {
                this.suspendForFood();
                try { this.bot.stopDigging(); } catch (_) { }
                try { this.bot.pathfinder.stop(); } catch (_) { }
                this.currentTask = null;
            }
            if (!this.waitingForHealth) {
                this.waitingForHealth = true;
                try { this.bot.chat('[SpeedBot] Je recupere ma vie avant de redescendre.'); } catch (_) { }
            }
            return;
        }
        this.waitingForHealth = false;

        // ===== BESOIN VITAL : NOURRITURE (verifie a CHAQUE tick) =====
        // DOIT etre ici, hors de decideNext() : une tache longue (DigDown...) peut
        // monopoliser currentTask indefiniment et empecher decideNext de tourner ->
        // le bot mourrait de faim sans jamais re-evaluer. On interrompt donc meme
        // une tache en cours quand la faim devient critique.
        // Apres une recherche de nourriture infructueuse, on ne relance pas la chasse
        // avant la fin de la pause (sinon boucle GetFood -> spam chat -> kick) ;
        // le bot continue ses taches normales en attendant.
        if (this.bot.food <= 6 && !(this.currentTask instanceof GetFood) && Date.now() < (this.foodUrgentRetryUntil || 0)) return;
        if (decision.activity === 'food' &&
            !(this.currentTask instanceof GetFood) && (this.bot.food <= 6 ? Date.now() >= (this.foodUrgentRetryUntil || 0) : !this.foodSearchPaused())) {
            if (this.currentTask) {
                try { this.bot.stopDigging(); } catch (e) { }
                try { this.bot.pathfinder.stop(); } catch (e) { }
                try { this.bot.clearControlStates(); } catch (e) { }
            }
            console.log(`[Agent] Faim critique ${this.bot.food}/20 -> interruption pour GetFood`);
            this.suspendForFood();
            this.currentTask = new GetFood(this.bot);
        }
        if (this.deathRecovery.pending && !(this.currentTask instanceof GetFood)) {
            await this.deathRecovery.run();
            return;
        }
        if (this.bot.food > 6 && !(this.currentTask instanceof GetFood)) await this.torchLighting?.tick();

        if (Date.now() < this.mobRoutePauseUntil && !(this.currentTask instanceof GetFood)) return;

        // A suspended ledge cannot be made safe by retrying the same staircase.
        // Keep critical food tasks and Survival active while mining is paused.
        if (this.unsafeDigSite) {
            if (this.bot.entity.position.distanceTo(this.unsafeDigSite) < 6) {
                if (!(this.currentTask instanceof GetFood)) return;
            } else {
                console.log('[Agent] Nouvelle position: reprise de la descente.');
                this.unsafeDigSite = null;
                this.failedTasks.DigDown = 0;
                this.lastFailedTask = null;
            }
        }

        this.resumeSuspendedTask();
        if (this.currentTask) {
            console.log(`[DEBUG] Tick: Current task is ${this.currentTask.name}, done=${this.currentTask.isDone()}`);
        } else {
            console.log(`[DEBUG] Tick: No current task`);
        }

        if (this.currentTask && !this.currentTask.isDone()) {
            const task = this.currentTask;
            let watchdog;
            let onDeath;
            try {
                // WATCHDOG : une tache qui se FIGE (await jamais resolu, ex: bot.dig
                // bloque par l'eau / une grotte) contournerait le disjoncteur, qui ne
                // s'evalue que dans decideNext() -> jamais atteint si run() ne rend pas
                // la main. On borne donc chaque run() dans le temps.
                const WATCHDOG_MS = 45000;
                await Promise.race([
                    task.run(),
                    new Promise((_, reject) => {
                        watchdog = setTimeout(() => reject(new Error('Watchdog: tache figee >45s')), WATCHDOG_MS);
                    }),
                    new Promise((_, reject) => {
                        onDeath = () => reject(new Error('Tache interrompue par la mort'));
                        this.bot.once('death', onDeath);
                    })
                ]);
            } catch (err) {
                if (err.code === 'ACTION_INTERRUPTED') return;
                if (this.currentTask !== task) return;
                console.log(`Task Error: ${err.message}`);
                // En cas de blocage : couper proprement minage / pathfinding / controles.
                try { this.bot.stopDigging(); } catch (e) { }
                try { this.bot.pathfinder.stop(); } catch (e) { }
                try { this.bot.clearControlStates(); } catch (e) { }
                // Track failed tasks (un gel compte plus lourd qu'un simple echec).
                const taskName = this.currentTask.name;
                const strike = /Watchdog/.test(err.message) ? 3 : 1;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + strike;
                this.lastFailedTask = taskName;
                if (taskName === 'DigDown' && this.currentTask.failureReason === 'Reserve de pioche pour la remontee') {
                    this.bot.chat('[SpeedBot] Durabilite insuffisante : retour avant de casser la derniere pioche.');
                    this.currentTask = new MoveToSurface(this.bot);
                    return;
                }
                this.currentTask = null;
            } finally {
                clearTimeout(watchdog);
                if (onDeath) this.bot.removeListener('death', onDeath);
            }
            return;
        }

        // If current task is done, check if it failed
        if (this.currentTask && this.currentTask.isDone()) {
            if (this.currentTask.hasFailed) {
                const taskName = this.currentTask.name;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + 1;
                this.lastFailedTask = taskName;
                if (taskName === 'DigDown' && this.currentTask.failureReason === 'Vide infranchissable') {
                    const message = '[SpeedBot] Grotte sous la marche: je cherche une sortie avec un sol stable.';
                    console.log(`[Agent] ${message}`);
                    try { this.bot.chat(message); } catch (e) { }
                    this.currentTask = new EscapeCaveLedge(this.bot);
                    return;
                }
                if (taskName === 'EscapeCaveLedge') {
                    this.unsafeDigSite = this.bot.entity.position.clone();
                    const p = this.unsafeDigSite.floored();
                    const message = `[SpeedBot] Sortie impossible a ${p.x}, ${p.y}, ${p.z}: ${this.currentTask.failureReason}. J'attends en securite.`;
                    console.log(`[Agent] ${message}`);
                    try { this.bot.chat(message); } catch (e) { }
                    this.currentTask = null;
                    return;
                }
                if (this.currentTask.failureReason?.startsWith('Mobs sur le trajet')) {
                    this.combatPreparation.noteBlocked();
                    this.mobRoutePauseUntil = Date.now() + 30000;
                    const message = '[SpeedBot] Trajet differe: des mobs sont proches. Nouvelle tentative dans 30 s.';
                    console.log(`[Agent] ${message}`);
                    try { this.bot.chat(message); } catch (_) { }
                    this.currentTask = null;
                    return;
                }
                if (taskName === 'GetFood' &&
                    ['Pas d\'animal proche', 'Zone de nourriture dangereuse'].includes(this.currentTask.failureReason)) {
                    this.pauseFoodSearch(this.currentTask.failureReason);
                    this.currentTask = null;
                    return;
                }
            } else {
                if (this.currentTask.name === 'GetFood') this.foodNoticeKey = null;
                this.bot.mobBlockedSince = 0;
                this.bot.lastMobBlock = 0;
                // Tache reussie : on remet a zero son compteur d'echec + le disjoncteur.
                this.failedTasks[this.currentTask.name] = 0;
                this.lastFailedTask = null;
                this.recoverAttempts = 0;
            }
            this.currentTask = null;
        }

        if (this.resumeSuspendedTask()) return;
        await this.decideNext();
        // Une nouvelle tache de progression remplace l'ancien objectif.
        if (this.currentTask && !(this.currentTask instanceof GetFood)) this.suspendedTask = null;
    }

    // Recuperation generique declenchee par le disjoncteur quand une tache boucle.
    // Escalade : bois (dependance universelle) -> relocalisation sol plat -> wander + reset.
    // Retourne true si une action de recuperation a ete engagee.
    async recover(stuckTask, inv, has, count) {
        const { goals } = require('mineflayer-pathfinder');
        this.recoverAttempts = (this.recoverAttempts || 0) + 1;

        // Apres plusieurs recuperations infructueuses : wander lointain + reset complet.
        if (this.recoverAttempts >= 4) {
            console.log("[Agent][Recover] Trop de recuperations -> wander lointain + reset complet des echecs.");
            const p = this.bot.entity.position;
            const ang = Math.random() * Math.PI * 2;
            try {
                await this.bot.pathfinder.goto(new goals.GoalNear(p.x + Math.cos(ang) * 40, p.y, p.z + Math.sin(ang) * 40, 4));
            } catch (e) { }
            this.failedTasks = {};
            this.recoverAttempts = 0;
            return true;
        }

        // 1) Le bois est la dependance universelle (planches, batons, manches, combustible).
        //    Si on en manque ET que ce n'est pas GetWood lui-meme qui boucle, on va en chercher.
        if (stuckTask !== 'GetWood' && count('log') < 1 && count('planks') < 2) {
            console.log("[Agent][Recover] Manque de bois -> GetWood.");
            this.currentTask = new GetWood(this.bot, 3);
            return true;
        }

        // 2) Sinon, changer physiquement d'endroit : echappe les perchoirs / terrains
        //    qui bloquent le pathfinder. On vise un sol plat un peu eloigne.
        const ground = this.bot.findBlock({
            matching: [this.mcData.blocksByName.grass_block.id, this.mcData.blocksByName.dirt.id],
            maxDistance: 48,
            useExtraInfo: (b) => {
                const a1 = this.bot.blockAt(b.position.offset(0, 1, 0));
                const a2 = this.bot.blockAt(b.position.offset(0, 2, 0));
                if (!a1 || !a2 || a1.name !== 'air' || a2.name !== 'air') return false;
                if (b.position.distanceTo(this.bot.entity.position) <= 8) return false;
                // Rejeter les emplacements proches de l'eau : DigDown (et le pathfinder)
                // detestent l'eau. On veut une colonne seche pour repartir proprement.
                const around = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0],
                [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
                for (const o of around) {
                    const nb = this.bot.blockAt(b.position.offset(o[0], o[1], o[2]));
                    if (nb && nb.name.includes('water')) return false;
                }
                return true;
            }
        });
        if (ground) {
            console.log(`[Agent][Recover] Relocalisation vers sol plat ${ground.position}.`);
            try {
                await this.bot.pathfinder.goto(new goals.GoalNear(ground.position.x, ground.position.y + 1, ground.position.z, 1));
            } catch (e) {
                console.log(`[Agent][Recover] Relocalisation echouee: ${e.message}`);
            }
            return true;
        }

        // 3) Pas de sol plat trouve : wander court pour debloquer.
        console.log("[Agent][Recover] Aucun sol plat -> wander court.");
        const p = this.bot.entity.position;
        const ang = Math.random() * Math.PI * 2;
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(p.x + Math.cos(ang) * 20, p.y, p.z + Math.sin(ang) * 20, 3));
        } catch (e) { }
        return true;
    }

    async decideNext() {
        // Check if bot is in water - if so, wait for survival system to get us out
        // Check if bot is in water - if so, wait for survival system to get us out
        /*
        const pos = this.bot.entity.position;
        const feetBlock = this.bot.blockAt(pos.floored());
        const headBlock = this.bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        if (inWater) {
            console.log('[Agent] Waiting for bot to escape water before starting new tasks...');
            await this.bot.waitForTicks(20);
            return;
        }
        */

        const inv = this.bot.inventory.items();
        const summary = inv.map(i => `${i.name}x${i.count}`).join(', ');
        console.log(`[Agent] Stage: ${this.stage} | Inventory: ${summary.substring(0, 100)}...`);

        const has = (name) => inv.some(i => {
            if (name === 'cobblestone') return i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name === 'blackstone';
            return i.name.includes(name);
        });
        const count = (name) => inv.filter(i => {
            if (name === 'cobblestone') return i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name === 'blackstone';
            return i.name.includes(name);
        }).reduce((a, b) => a + b.count, 0);

        // ===== AUTO-DEDUCTION DE L'ETAPE (anti "recommencer au debut") =====
        // L'inventaire est conserve cote serveur entre deux lancements. On deduit
        // l'etape minimale a partir du MEILLEUR materiel possede, et on n'avance
        // jamais en arriere. Evite de refaire l'early game quand on a deja, p.ex.,
        // une pioche en fer (mais plus de pioche en pierre).
        const STAGE_ORDER = ['EARLY_GAME', 'IRON', 'DIAMOND', 'NETHER', 'STRONGHOLD', 'END'];
        const atLeast = (target) => {
            if (STAGE_ORDER.indexOf(target) > STAGE_ORDER.indexOf(this.stage)) {
                console.log(`[Agent] Materiel detecte -> saut direct a l'etape ${target} (pas de retour en arriere).`);
                this.setStage(target);
            }
        };
        if (has('diamond_pickaxe')) atLeast('NETHER');
        else if (has('iron_pickaxe')) atLeast('DIAMOND');

        // ===== DISJONCTEUR GLOBAL ANTI-BOUCLE =====
        // Filet de securite pour TOUTE la classe de bugs "tache qui echoue en boucle".
        // Les handlers d'etape ont leurs propres seuils (3, 5/6) ; ce seuil plus haut (8)
        // n'intervient qu'en dernier recours, quand rien d'autre n'a debloque la situation.
        const LOOP_THRESHOLD = 8;
        if (this.lastFailedTask && (this.failedTasks[this.lastFailedTask] || 0) >= LOOP_THRESHOLD) {
            const stuckTask = this.lastFailedTask;
            console.log(`[Agent] DISJONCTEUR: '${stuckTask}' a echoue ${this.failedTasks[stuckTask]} fois d'affilee -> recuperation.`);
            this.failedTasks[stuckTask] = 0;
            this.lastFailedTask = null;
            if (await this.recover(stuckTask, inv, has, count)) return;
        }

        // ===== PRIORITE VITALE : NOURRITURE =====
        // A 0 de faim le bot prend des degats et ne regenere pas -> on mange/chasse
        // AVANT toute progression. (Le disjoncteur attrape GetFood s'il boucle.)
        // Pas de poulet cru (effet Hunger) ni chair putrefiee -> pas d'empoisonnement.
        const EDIBLE = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
            'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'apple', 'golden_apple',
            'baked_potato', 'carrot', 'melon_slice', 'beef', 'porkchop', 'mutton',
            'rabbit', 'cod', 'salmon'];
        const hasEdible = inv.some(i => EDIBLE.includes(i.name));
        if (this.bot.food <= 6 && this.foodSearchPaused()) return;
        if ((hasEdible && this.bot.food < 16) || (this.bot.food <= 6 && !this.foodSearchPaused())) {
            console.log(`[Agent] Faim ${this.bot.food}/20 -> GetFood (priorite vitale)`);
            this.currentTask = new GetFood(this.bot);
            return;
        }

        if (!has('shield') && (has('stone_pickaxe') || has('iron_pickaxe') || has('diamond_pickaxe')) &&
            await this.ensureShield(inv, has, count)) return;

        // ========== STAGE: EARLY_GAME ==========
        if (this.stage === 'EARLY_GAME') {
            const hasPick = has('stone_pickaxe');
            const hasSword = inv.some(i => i.name.includes('sword'));

            // Get stone pickaxe AND sword
            if (!hasPick || !hasSword) {
                // If stone_pickaxe craft failed more than 5 times, skip to IRON with wooden pickaxe
                // (Only skip if we at least have a pickaxe)
                if ((this.failedTasks['Craft_stone_pickaxe'] || 0) > 5 && has('wooden_pickaxe')) {
                    console.log("[Agent] Stone pickaxe craft failed multiple times, skipping to IRON stage with wooden pickaxe.");
                    this.setStage('IRON');
                    return;
                }

                await this.handleEarlyGame(inv, has, count);
                return;
            }
            console.log("[Agent] Early game complete! Moving to IRON stage.");
            this.setStage('IRON');
        }

        // ========== STAGE: IRON ==========
        if (this.stage === 'IRON') {
            if (!has('iron_pickaxe')) {
                await this.handleIronStage(inv, has, count);
                return;
            }
            console.log("[Agent] Iron stage complete! Moving to DIAMOND stage.");
            this.failedTasks = {}; // Reset des echecs en changeant d'etape
            this.setStage('DIAMOND');
        }

        // ========== STAGE: DIAMOND ==========
        if (this.stage === 'DIAMOND') {
            if (!has('diamond_pickaxe')) {
                this.handleDiamondStage(inv, has, count);
                return;
            }
            console.log("[Agent] Diamond stage complete! Moving to NETHER stage.");
            this.setStage('NETHER');
        }

        // ========== STAGE: NETHER ==========
        if (this.stage === 'NETHER') {
            if (count('blaze_rod') < 6 || count('ender_pearl') < 12) {
                await this.handleNetherStage(inv, has, count);
                return;
            }
            console.log("[Agent] Nether stage complete! Moving to STRONGHOLD stage.");
            this.setStage('STRONGHOLD');
        }

        // ========== STAGE: STRONGHOLD ==========
        if (this.stage === 'STRONGHOLD') {
            const endPortal = this.bot.findBlock({
                matching: this.mcData.blocksByName.end_portal?.id,
                maxDistance: 16
            });
            if (!endPortal) {
                this.handleStrongholdStage(inv, has, count);
                return;
            }
            console.log("[Agent] Stronghold found! Moving to END stage.");
            this.setStage('END');
        }

        // ========== STAGE: END (Fight Dragon) ==========
        if (this.stage === 'END') {
            this.handleEndStage(inv, has, count);
            return;
        }

        console.log("[Agent] VICTORY! Ender Dragon defeated!");
    }

    // ==================== EARLY GAME ====================
    async handleEarlyGame(inv, has, count) {
        // 1. Get Wood
        if (count('log') < 3 && count('planks') < 5 && !has('wooden_pickaxe')) {
            console.log("Goal: Get Wood");
            this.currentTask = new GetWood(this.bot, 3);
            return;
        }

        // 2. Craft Planks
        if (count('planks') < 8 && !has('crafting_table') && !has('wooden_pickaxe')) {
            if (count('log') === 0 && count('planks') < 4) {
                // Check if we have logs to craft planks
                console.log("[Agent] Need planks but no logs! Going to GetWood.");
                this.currentTask = new GetWood(this.bot, 3);
                return;
            }

            console.log("Goal: Craft Planks");
            let targetPlank = 'oak_planks';
            const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
            if (logItem) {
                targetPlank = `${logItem.name.replace('_log', '')}_planks`;
            }
            this.currentTask = new CraftTask(this.bot, targetPlank, 8);
            return;
        }

        // 3. Craft Table
        if (!has('crafting_table') && !has('wooden_pickaxe')) {
            console.log("Goal: Craft Table");
            this.currentTask = new CraftTask(this.bot, 'crafting_table');
            return;
        }

        // 4. Craft Sticks + Wooden Pickaxe
        if (!has('wooden_pickaxe') && !has('stone_pickaxe')) {
            if (count('stick') < 2) {
                if (count('planks') < 2) {
                    if (count('log') > 0) {
                        const logItem = inv.find(i => i.name.endsWith('_log') && !i.name.startsWith('stripped_'));
                        const plankName = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                        console.log(`[Agent] Need sticks: crafting ${plankName} from existing logs.`);
                        this.currentTask = new CraftTask(this.bot, plankName, 4);
                    } else {
                        console.log("[Agent] Need sticks but no wood. Going to GetWood.");
                        this.currentTask = new GetWood(this.bot, 3);
                    }
                    return;
                }
                console.log("Goal: Craft Sticks");
                this.currentTask = new CraftTask(this.bot, 'stick', 2);
                return;
            }

            // Check for Planks (Need 3 for Pickaxe)
            if (count('planks') < 3) {
                if (count('log') > 0) {
                    console.log("Goal: Craft Planks for Pickaxe");
                    let targetPlank = 'oak_planks';
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    if (logItem) {
                        targetPlank = `${logItem.name.replace('_log', '')}_planks`;
                    }
                    this.currentTask = new CraftTask(this.bot, targetPlank, 4); // Craft 1 batch (4 planks)
                    return;
                } else {
                    console.log("[Agent] Need planks for pickaxe but no logs! Going to GetWood.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
            }

            console.log("Goal: Craft Wooden Pickaxe");
            this.currentTask = new CraftTask(this.bot, 'wooden_pickaxe');
            return;
        }

        // 5. Mine Stone
        // Ensure we have a backup pickaxe if we are going to mine stone heavily
        if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

        if (!has('stone_pickaxe')) {
            if (count('cobblestone') < 3) {
                console.log("Goal: Mine Stone");
                this.currentTask = new MineBlock(this.bot, 'stone', 3);
                return;
            }

            // Ensure sticks
            if (count('stick') < 2) {
                console.log("Goal: Craft Sticks for Stone Pickaxe");
                this.currentTask = new CraftTask(this.bot, 'stick', 4);
                return;
            }

            console.log("Goal: Craft Stone Pickaxe");
            this.currentTask = new CraftTask(this.bot, 'stone_pickaxe');
            return;
        }

        // 6. Craft Stone Sword (Defense)
        const hasSword = inv.some(i => i.name.includes('sword'));
        if (!hasSword) {
            const cobbleCount = count('cobblestone');
            console.log(`[Agent] Checking sword: cobblestone=${cobbleCount}, need=2`);

            if (cobbleCount < 2) {
                console.log("Goal: Mine Stone for Sword");
                this.currentTask = new MineBlock(this.bot, 'stone', 2);
                return;
            }
            if (count('stick') < 1) {
                console.log("Goal: Craft Stick for Sword");
                this.currentTask = new CraftTask(this.bot, 'stick', 4);
                return;
            }

            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            console.log("Goal: Craft Stone Sword");
            this.currentTask = new CraftTask(this.bot, 'stone_sword');
            return;
        }
    }

    // ==================== IRON STAGE ====================
    async handleIronStage(inv, has, count) {
        // CRITICAL: If we have NO pickaxe, reset to EARLY_GAME
        const pickaxes = inv.filter(i => i.name.includes('pickaxe'));
        if (pickaxes.length === 0) {
            console.log("[Agent] CRITICAL: No pickaxe found! Resetting to EARLY_GAME.");
            this.setStage('EARLY_GAME');
            return;
        }

        // Ensure backup stone pickaxe if we are deep down
        if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

        // 0. Recuperer le fer reste DANS LE FOUR (ex: fonte interrompue par un crash/restart)
        //    AVANT de re-miner. Sinon on ne compte que l'inventaire et on re-mine pour rien.
        //    Symptome : on a deja des lingots mais pas 6, et plus de minerai brut en main.
        //    Si le four est vide, SmeltTask echoue -> on tombe sur l'etape de minage.
        const smeltCollectName = 'Smelt_raw_iron_to_iron_ingot';
        if (count('iron_ingot') >= 1 && count('iron_ingot') < 3 && count('raw_iron') === 0
            && (this.failedTasks[smeltCollectName] || 0) === 0) {
            const furnaceNearby = this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace?.id,
                maxDistance: 16
            });
            if (furnaceNearby) {
                console.log("[Agent] Lingots manquants + four a proximite -> recuperation de la fonte avant de re-miner.");
                this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 3);
                return;
            }
        }

        // 1. Three ingots are enough for the iron pickaxe; shield/sword are disabled.
        if (count('raw_iron') + count('iron_ingot') < 3) {
            if (this.bot.entity.position.y > 58 && this.bot.caveMiningTarget?.oreName !== 'iron_ore') {
                console.log('[Agent] Fer trop profond: descente en escalier avant de chercher le minerai.');
                const DigDown = require('./tasks/DigDown');
                this.currentTask = new DigDown(this.bot, 54);
                return;
            }
            console.log("Goal: Mine Iron Ore");
            this.currentTask = new MineBlock(this.bot, 'iron_ore', 3);
            return;
        }


        // 2a. Craft Shield - TEMPORARILY DISABLED (infinite loop with GetWood)
        // Will re-enable once GetWood task is fixed
        /*
        if (!has('shield') && count('iron_ingot') >= 1) {
            const totalPlanks = count('planks');
            if (totalPlanks < 6) {
                const logsAvailable = count('log');
                console.log(`\n\n========== SHIELD CHECK ==========`);
                console.log(`Planks: ${totalPlanks}/6, Logs: ${logsAvailable}`);
                
                if (logsAvailable < 2) {
                    const logsNeeded = 2 - logsAvailable;
                    console.log(`Goal: Get Wood for Shield (need ${logsNeeded} more logs)`);
                    this.currentTask = new GetWood(this.bot, logsNeeded);
                    return;
                } else {
                    console.log("Goal: Craft Planks for Shield (have enough logs)");
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                    this.currentTask = new CraftTask(this.bot, plankType, 2);
                    return;
                }
            }

            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            console.log("Goal: Craft Shield");
            this.currentTask = new CraftTask(this.bot, 'shield');
            return;
        }
        */


        // 2-3. Four puis fonte des 3 lingots de la pioche.
        if (await this.smeltIron(3, inv, has, count)) return;

        // 4. Craft Iron Pickaxe
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return;

        // Manche necessaire : on remonte la chaine batons <- planches <- bois.
        // (L'epee en fer est volontairement laissee de cote : une fois la pioche en fer
        // obtenue on passe a DIAMOND, pour ne pas re-declencher de collecte de bois.)
        if (count('stick') < 2) {
            if (count('planks') < 2) {
                if (count('log') > 0) {
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                    console.log(`Goal: Craft Planks for Sticks`);
                    this.currentTask = new CraftTask(this.bot, plankType, 4);
                    return;
                }
                // Ni planches ni logs : il faut du bois, sinon Craft_stick echoue a l'infini.
                console.log("[Agent] Besoin de batons mais ni planches ni bois. Recolte de bois.");
                this.currentTask = new GetWood(this.bot, 3);
                return;
            }
            console.log("Goal: Craft Sticks");
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        console.log("Goal: Craft Iron Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'iron_pickaxe');
        return;
    }

    // Four + fonte jusqu'a `n` lingots de fer (minerai brut deja en main).
    // Retourne true si une tache a ete choisie pour ce tick.
    async smeltIron(n, inv, has, count) {
        // Four (craft, ou four deja pose a proximite)
        console.log(`[DEBUG] has(furnace): ${has('furnace')}, failed(Craft_furnace): ${this.failedTasks['Craft_furnace'] || 0}`);
        if (!has('furnace') && count('iron_ingot') < n) {
            // Check if we already have a furnace placed nearby
            const nearbyFurnace = this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace?.id,
                useExtraInfo: block => !!block?.position && !threatNearPoint(this.bot, block.position, 4),
                maxDistance: 32
            });

            if (nearbyFurnace) {
                console.log("[DEBUG] Found placed furnace nearby, skipping craft.");
            } else {
                // Ensure we have a crafting table first (or wood to make one)
                await this.ensureTable(inv, has, count);
                if (this.currentTask) return true;

                // If furnace craft failed more than 5 times AND we have a placed furnace nearby, skip
                if ((this.failedTasks['Craft_furnace'] || 0) > 5) {
                    const furnaceBlock = this.bot.findBlock({
                        matching: this.mcData.blocksByName.furnace?.id,
                        useExtraInfo: block => !!block?.position && !threatNearPoint(this.bot, block.position, 4),
                        maxDistance: 64
                    });
                    if (furnaceBlock) {
                        console.log("[Agent] Furnace craft failed multiple times, but found placed furnace nearby. Continuing.");
                    } else {
                        console.log("[Agent] Furnace craft failed multiple times. Moving to surface to find better location.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return true;
                    }
                } else {
                    if (count('cobblestone') < 8) {
                        console.log("Goal: Mine Cobblestone for Furnace");
                        this.currentTask = new MineBlock(this.bot, 'stone', 8);
                        return true;
                    }
                    console.log("Goal: Craft Furnace");
                    console.log("[DEBUG] Setting task: Craft_furnace");
                    this.currentTask = new CraftTask(this.bot, 'furnace');
                    return true;
                }
            }
        }

        // Fonte des lingots manquants.
        if (count('iron_ingot') < n) {
            const smeltTaskName = 'Smelt_raw_iron_to_iron_ingot';
            if ((this.failedTasks[smeltTaskName] || 0) > 2) {
                console.log("[Agent] Smelting failed multiple times. Relocating to flat ground.");
                this.failedTasks[smeltTaskName] = 0;

                // Apres MoveToSurface, le bot finit souvent perche sur un pilier d'1 bloc
                // (a travers les arbres) ou aucun fourneau ne peut etre pose. On rejoint un
                // vrai sol plat au lieu de relancer MoveToSurface (no-op quand deja en surface).
                const ground = this.bot.findBlock({
                    matching: [this.mcData.blocksByName.grass_block.id, this.mcData.blocksByName.dirt.id],
                    maxDistance: 32,
                    useExtraInfo: (b) => {
                        const a1 = this.bot.blockAt(b.position.offset(0, 1, 0));
                        const a2 = this.bot.blockAt(b.position.offset(0, 2, 0));
                        return a1 && a2 && a1.name === 'air' && a2.name === 'air';
                    }
                });

                if (ground) {
                    console.log(`[Agent] Relocating to flat ground at ${ground.position}`);
                    try {
                        const { goals } = require('mineflayer-pathfinder');
                        await this.bot.pathfinder.goto(new goals.GoalNear(ground.position.x, ground.position.y + 1, ground.position.z, 1));
                    } catch (e) {
                        console.log(`[Agent] Relocation failed: ${e.message}`);
                    }
                } else {
                    // Aucun sol plat a proximite : fallback historique
                    this.currentTask = new MoveToSurface(this.bot);
                }
                return true;
            }

            console.log("Goal: Smelt Iron");

            // CHECK FOR FUEL
            // If we check for fuel in inventory.
            const fuels = inv.filter(i =>
                i.name.includes('coal') ||
                i.name.includes('log') ||
                i.name.includes('planks') ||
                i.name.includes('charcoal')
            );

            if (fuels.length === 0) {
                console.log("[Agent] Need to smelt but have NO FUEL detected in inventory.");

                // User Requirement: "look for coal in the caves"
                // 1. Ensure we have a pickaxe to mine coal
                if (await this.ensurePickaxeRedundancy(inv, has, count)) return true;

                // 2. Try to find Coal Ore nearby
                const coalOre = this.bot.findBlock({
                    matching: ['coal_ore', 'deepslate_coal_ore'].map(name => this.mcData.blocksByName[name].id),
                    maxDistance: 32
                });

                if (coalOre) {
                    console.log("[Agent] Found Coal Ore nearby! Mining for fuel.");
                    this.currentTask = new MineBlock(this.bot, 'coal_ore', 3);
                    return true;
                } else {
                    console.log("[Agent] No Coal Ore found nearby. Checking surface/wood fallback.");
                    // If we are deep underground and no coal, we must surface.
                    if (this.bot.entity.position.y < 60) {
                        console.log("[Agent] Underground, no coal, no fuel. Returning to surface for wood/survival.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return true;
                    }
                    // If on surface, get wood
                    console.log("[Agent] On surface (or close). getting wood for fuel.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return true;
                }
            }

            // SmeltTask verifie le terrain et les mobs : une galerie sure convient aussi.
            this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', n);
            return true;
        }
        return false;
    }

    // ==================== DIAMOND STAGE ====================
    async handleDiamondStage(inv, has, count) {
        // Recovery: If we died and lost our pickaxe, we need to go back
        if (!has('iron_pickaxe') && !has('diamond_pickaxe')) {
            console.log("[Agent] In Diamond Stage but lost pickaxe! Reverting to Iron gear recovery.");
            // Fallback to iron stage logic temporarily
            await this.handleIronStage(inv, has, count);
            return;
        }

        // Mine diamonds (need to go deep, y < 16)
        if (count('diamond') < 3) {
            // Need to go deep?
            if (this.bot.entity.position.y > 16 && this.bot.caveMiningTarget?.oreName !== 'diamond_ore') {
                console.log("Goal: Go Deep for Diamonds");
                const DigDown = require('./tasks/DigDown');
                this.currentTask = new DigDown(this.bot, -54); // Go to -54 (deepslate)
                return;
            }

            console.log("Goal: Mine Diamonds");
            this.currentTask = new MineBlock(this.bot, 'diamond_ore', 3);
            return;
        }

        // Craft Diamond Pickaxe
        this.ensureTable(inv, has, count);
        if (this.currentTask) return;

        if (count('stick') < 2) {
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        console.log("Goal: Craft Diamond Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'diamond_pickaxe');
    }

    // ==================== NETHER STAGE ====================
    async handleNetherStage(inv, has, count) {
        const exact = (name) => inv.filter(i => i.name === name).reduce((a, i) => a + i.count, 0);
        const portalNear = this.bot.findBlock({
            matching: this.mcData.blocksByName.nether_portal?.id,
            maxDistance: 64
        });

        // 0. Equipement perdu (mort...) : l'obsidienne exige une pioche en diamant.
        //    On repasse par la logique diamant (qui elle-meme redescend au fer si besoin).
        if (!portalNear && exact('obsidian') < 10 &&
            !has('diamond_pickaxe') && !has('netherite_pickaxe')) {
            console.log("[Agent] Etape NETHER sans pioche en diamant -> recuperation de l'equipement.");
            await this.handleDiamondStage(inv, has, count);
            return;
        }

        if (!portalNear) {
            // 1. Fer necessaire : seau (3 lingots) + briquet (1 lingot).
            const needsBucket = exact('obsidian') < 10 && exact('bucket') + exact('water_bucket') === 0;
            const ironNeeded = (needsBucket ? 3 : 0) + (has('flint_and_steel') ? 0 : 1);
            if (ironNeeded > 0 && exact('iron_ingot') < ironNeeded) {
                if (exact('raw_iron') + exact('iron_ingot') < ironNeeded) {
                    if (this.bot.entity.position.y > 58) {
                        console.log('[Agent] Fer: descente en escalier avant de chercher le minerai.');
                        const DigDown = require('./tasks/DigDown');
                        this.currentTask = new DigDown(this.bot, 54);
                        return;
                    }
                    console.log(`Goal: Mine Iron Ore (seau/briquet: ${ironNeeded} lingots)`);
                    this.currentTask = new MineBlock(this.bot, 'iron_ore', exact('raw_iron') + ironNeeded - exact('iron_ingot'));
                    return;
                }
                if (await this.smeltIron(ironNeeded, inv, has, count)) return;
            }

            // 2. Obsidienne fabriquee a partir de lave + seau d'eau.
            if (exact('obsidian') < 10) {
                if (needsBucket) {
                    await this.ensureTable(inv, has, count);
                    if (this.currentTask) return;
                    console.log('Goal: Craft Bucket');
                    this.currentTask = new CraftTask(this.bot, 'bucket');
                    return;
                }
                if (!exact('water_bucket')) {
                    console.log('Goal: Fill Water Bucket');
                    this.currentTask = new FillBucket(this.bot);
                    return;
                }
                console.log('Goal: Make Obsidian (eau + lave)');
                this.currentTask = new MakeObsidian(this.bot, 10);
                return;
            }

            // 3. Briquet : silex (gravier) + 1 lingot.
            if (!has('flint_and_steel')) {
                if (!exact('flint')) {
                    // Le silex ne tombe qu'une fois sur 10 : viser "gravier actuel + 3", sinon
                    // la tache se croit finie des qu'on a assez de gravier, sans silex.
                    console.log("Goal: Mine Gravel for Flint");
                    this.currentTask = new MineBlock(this.bot, 'gravel', exact('gravel') + 3);
                    return;
                }
                console.log("Goal: Craft Flint and Steel");
                this.currentTask = new CraftTask(this.bot, 'flint_and_steel');
                return;
            }
        }

        // 4. Construire et allumer le portail.
        if (!portalNear) {
            console.log("Goal: Build Nether Portal");
            this.currentTask = new BuildNetherPortal(this.bot);
            return;
        }

        // 5. Enter Nether & Find Blaze
        if (count('blaze_rod') < 6) {
            console.log("Goal: Hunt Blazes");
            this.currentTask = new FightMob(this.bot, 'blaze', 6);
            return;
        }

        // 6. Get Ender Pearls (from Endermen or Piglins)
        if (count('ender_pearl') < 12) {
            console.log("Goal: Get Ender Pearls");
            this.currentTask = new FightMob(this.bot, 'enderman', 12);
            return;
        }

        // 7. Craft Eyes of Ender
        if (count('ender_eye') < 12) {
            // Craft blaze powder first
            if (count('blaze_powder') < 12) {
                console.log("Goal: Craft Blaze Powder");
                this.currentTask = new CraftTask(this.bot, 'blaze_powder', 12);
                return;
            }
            console.log("Goal: Craft Eyes of Ender");
            this.currentTask = new CraftTask(this.bot, 'ender_eye', 12);
            return;
        }
    }

    // ==================== STRONGHOLD STAGE ====================
    handleStrongholdStage(inv, has, count) {
        console.log("Goal: Find Stronghold");
        this.currentTask = new FindStronghold(this.bot);
    }

    // ==================== END STAGE ====================
    handleEndStage(inv, has, count) {
        console.log("Goal: Fight Ender Dragon!");
        this.currentTask = new FightDragon(this.bot);
    }

    // ==================== HELPERS ====================
    async ensureShield(inv, has, count) {
        if (has('shield')) return false;
        if (count('iron_ingot') < 1) {
            if (count('raw_iron') < 1) {
                this.currentTask = this.bot.entity.position.y > 58 && this.bot.caveMiningTarget?.oreName !== 'iron_ore' ?
                    new (require('./tasks/DigDown'))(this.bot, 54, 'iron_ore') : new MineBlock(this.bot, 'iron_ore', 1);
            } else await this.smeltIron(1, inv, has, count);
            return true;
        }
        if (count('planks') < 6) {
            const log = inv.find(i => i.name.endsWith('_log'));
            this.currentTask = log ? new CraftTask(this.bot, log.name.replace('_log','_planks'), 6) : new GetWood(this.bot, 3);
            return true;
        }
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return true;
        this.bot.chat('[SpeedBot] Fabrication du bouclier pour me defendre.');
        this.currentTask = new CraftTask(this.bot, 'shield');
        return true;
    }

    async ensureTable(inv, has, count) {
        const tableBlock = this.bot.findBlock({
            matching: this.mcData.blocksByName.crafting_table.id,
            useExtraInfo: block => CraftTask.usableTable(this.bot, block),
            maxDistance: 4
        });

        // Table already placed nearby
        if (tableBlock) {
            console.log(`[DEBUG] ensureTable: Found table at ${tableBlock.position}`);
            return;
        }

        // Table in inventory, need to place it
        if (!this.bot.inventory.items().some(i=>i.name==='crafting_table'))
            await require('./lib/Workstations')(this.bot).recover('crafting_table');
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (tableItem) {
            console.log("Goal: Place Crafting Table");
            // Place it
            const { Vec3 } = require('vec3');
            const nearby = this.bot.findBlocks({
                matching: b => b.type !== this.mcData.blocksByName.air.id && b.boundingBox === 'block',
                maxDistance: 4,
                count: 10
            });

            for (const pos of nearby) {
                const above = pos.offset(0, 1, 0);
                const blockAbove = this.bot.blockAt(above);
                if (blockAbove && blockAbove.type === this.mcData.blocksByName.air.id) {
                    if (this.bot.entity.position.distanceTo(above) > 1.5) {
                        try {
                            await this.bot.equip(tableItem, 'hand');
                            await this.bot.placeBlock(this.bot.blockAt(pos), new Vec3(0, 1, 0));
                            require('./lib/Workstations')(this.bot).remember('crafting_table',above);
                            console.log("Placed crafting table!");
                            return;
                        } catch (e) {
                            console.log(`Place table error: ${e.message}`);
                        }
                    }
                }
            }
            return;
        }

        // No table anywhere, need to craft
        if (count('planks') < 4) {
            if (count('log') < 1) {
                console.log("Goal: Get Wood for Table");
                this.currentTask = new GetWood(this.bot, 2);
                return;
            }
            const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
            let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
            console.log(`Goal: Craft ${plankType}`);
            this.currentTask = new CraftTask(this.bot, plankType, 4);
            return;
        }
        console.log("Goal: Craft Crafting Table");
        this.currentTask = new CraftTask(this.bot, 'crafting_table');
    }

    // Ensure we have at least 2 pickaxes so we don't get stuck mining without one
    async ensurePickaxeRedundancy(inv, has, count) {
        // Only run this check if we are NOT already doing a craft/surface task
        // to avoid recursion loops if we are already fixing it.
        if (this.currentTask && (
            this.currentTask.name.includes('Craft') ||
            this.currentTask.name.includes('Surface') ||
            this.currentTask.name.includes('GetWood')
        )) return false;

        const pickaxes = inv.filter(i => i.name.includes('pickaxe'));
        // If we have 2 or more, we are safe.
        if (pickaxes.length >= 2) return false;

        console.log(`[Agent] Redundancy Check: Only ${pickaxes.length} pickaxe(s). Need backup.`);

        // We need a backup STONE pickaxe (cheapest).
        // Do we have Materials? (3 cobble + 2 sticks)
        // If no cobble -> we are probably early game or just used it all. 
        // If we have existing pickaxe, we can mine cobble.

        // Do we have sticks?
        if (count('stick') < 2) {
            // Need planks?
            if (count('planks') < 2) {
                // Need logs?
                if (count('log') < 1) {
                    // NO WOOD. 
                    // If we are underground, we MUST go to surface.
                    if (this.bot.entity.position.y < 60) {
                        console.log("[Agent] CRITICAL: Single pickaxe, no wood, underground! Initiating emergency surface return.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return true;
                    }
                    // On surface, get wood
                    console.log("[Agent] Single pickaxe, no wood. Getting wood.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return true;
                }
                const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                console.log("[Agent] Crafting planks for redundancy sticks");
                this.currentTask = new CraftTask(this.bot, plankType, 4);
                return true;
            }
            console.log("[Agent] Crafting sticks for redundancy");
            this.currentTask = new CraftTask(this.bot, 'stick', 4);
            return true;
        }

        // We have sticks. Do we have cobble?
        if (count('cobblestone') < 3) {
            // Can we mine it? Yes if we have ANY pickaxe.
            const hasPick = pickaxes.length > 0;
            if (hasPick) {
                // It's okay to have <3 cobble, we can strip mine or standard mine.
                // But wait, if we are here, we want to PREPARE before a long mine session.
                // Let's just create one if we happen to have cobble. 
                // If we don't have cobble, checking redundancy might be premature unless durability is critically low.
                // Let's assume if we are mining Stone/Iron, we will get cobble soon.
                // So only force craft if we HAVE cobble.
                return false;
            } else {
                // No pickaxe at all? Logic elsewhere handles this (GetWood -> Wooden Pick).
                return false;
            }
        }

        // We have Sticks + Cobble. Need Table?
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return true;

        // Viser "une de plus" : avec count=1, CraftTask se croirait deja termine
        // si le bot possede deja une pioche en pierre (boucle infinie).
        const stonePicks = inv.filter(i => i.name === 'stone_pickaxe').length;
        console.log("[Agent] Crafting backup Stone Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'stone_pickaxe', stonePicks + 1);
        return true;
    }
}

module.exports = Agent;
