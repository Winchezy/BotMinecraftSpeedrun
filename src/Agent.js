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
const LocalBrain = require('./LocalBrain');
const fs = require('fs');
const path = require('path');

class Agent {
    constructor(bot) {
        this.bot = bot;
        this.currentTask = null;
        this.mcData = require('minecraft-data')(bot.version);
        this.stage = 'EARLY_GAME'; // EARLY_GAME, IRON, DIAMOND, NETHER, STRONGHOLD, END
        this.failedTasks = {}; // Echecs CONSECUTIFS par tache (reset au succes de la tache)
        this.lastFailedTask = null; // Derniere tache ayant echoue (pour le disjoncteur)
        this.recoverAttempts = 0;   // Escalade des recuperations du disjoncteur
        this._redundancyAttempts = 0; // Limite les tentatives de craft de pioche de secours
        this._pendingRecord = null; // Reward-based recording: état avant la tâche en cours

        this.brain = new LocalBrain();

        // Chat Listener for Status Updates
        this.bot.on('chat', (username, message) => {
            if (username === this.bot.username) return;

            const msg = message.toLowerCase();
            if (msg.includes('!status')) {
                this.bot.chat(`Health: ${this.bot.health.toFixed(0)}/20 | Food: ${this.bot.food.toFixed(0)}/20 | Task: ${this.currentTask ? this.currentTask.name : 'Idle'}`);
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

    async tick() {
        if (this.bot.isInCombat && this.bot.isInCombat()) {
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

        // ===== BESOIN VITAL : NOURRITURE (verifie a CHAQUE tick) =====
        // DOIT etre ici, hors de runStateMachine() : une tache longue (DigDown...) peut
        // monopoliser currentTask indefiniment et empecher la state machine de tourner ->
        // le bot mourrait de faim sans jamais re-evaluer. On interrompt donc meme
        // une tache en cours quand la faim devient critique.
        if (this.bot.food <= 6 && !(this.currentTask instanceof GetFood)) {
            if (this.currentTask) {
                this.currentTask.cancel();
                try { this.bot.stopDigging(); } catch (e) { }
                try { this.bot.pathfinder.stop(); } catch (e) { }
                try { this.bot.clearControlStates(); } catch (e) { }
            }
            console.log(`[Agent] Faim critique ${this.bot.food}/20 -> interruption pour GetFood`);
            this._pendingRecord = null; // la tache interrompue ne doit pas etre recompensee
            this.currentTask = new GetFood(this.bot);
        }

        if (this.currentTask) {
            console.log(`[DEBUG] Tick: Current task is ${this.currentTask.name}, done=${this.currentTask.isDone()}`);
        } else {
            console.log(`[DEBUG] Tick: No current task`);
        }

        // Si une tâche est en cours, la laisser finir
        if (this.currentTask && !this.currentTask.isDone()) {
            try {
                // WATCHDOG : une tache qui se FIGE (await jamais resolu, ex: bot.dig
                // bloque par l'eau / une grotte) contournerait le disjoncteur, qui ne
                // s'evalue que dans runStateMachine() -> jamais atteint si run() ne rend pas
                // la main. On borne donc chaque run() dans le temps.
                const WATCHDOG_MS = 45000;
                await Promise.race([
                    this.currentTask.run(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Watchdog: tache figee >45s')), WATCHDOG_MS))
                ]);
            } catch (err) {
                console.log(`Task Error: ${err.message}`);
                // Le run() figé continue en arrière-plan : le marquer annulé pour qu'il
                // s'arrête au lieu de piloter le bot en parallèle de la tâche suivante.
                this.currentTask.cancel();
                // En cas de blocage : couper proprement minage / pathfinding / controles.
                try { this.bot.stopDigging(); } catch (e) { }
                try { this.bot.pathfinder.stop(); } catch (e) { }
                try { this.bot.clearControlStates(); } catch (e) { }
                // Track failed tasks (un gel compte plus lourd qu'un simple echec).
                const taskName = this.currentTask.name;
                const strike = /Watchdog/.test(err.message) ? 3 : 1;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + strike;
                this.lastFailedTask = taskName;
                this._pendingRecord = null; // Échec → on ne garde pas l'exemple
                this.currentTask = null;
            }
            return;
        }

        // Tâche terminée, on la nettoie
        if (this.currentTask && this.currentTask.isDone()) {
            // Mémoriser si du minerai attend dans le four faute de combustible
            if (this.currentTask instanceof SmeltTask) {
                this._furnaceNeedsFuel = !!this.currentTask.needsFuel;
            }
            if (this.currentTask.hasFailed) {
                const taskName = this.currentTask.name;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + 1;
                this.lastFailedTask = taskName;
                this._pendingRecord = null; // Échec → on ne garde pas l'exemple
            } else {
                // Tache reussie : on remet a zero son compteur d'echec + le disjoncteur.
                this.failedTasks[this.currentTask.name] = 0;
                this.lastFailedTask = null;
                this.recoverAttempts = 0;
                if (this._pendingRecord) {
                    this._saveProgressionExample(this._pendingRecord.actionName, this._pendingRecord.input);
                    this._pendingRecord = null;
                }
            }
            this.currentTask = null;
        }

        const inv = this.bot.inventory.items();
        const summary = inv.map(i => `${i.name}x${i.count}`).join(', ');

        // --- ÉTAPE 1 : La state machine décide ---
        console.log(`[Agent] Stage: ${this.stage} | Inventory: ${summary.substring(0, 100)}...`);

        // Capturer l'état AVANT la décision (pour l'entraînement par récompense)
        let _stateBeforeDecision = null;
        try {
            const { encodeState } = require('./Recorder');
            _stateBeforeDecision = encodeState(this.bot);
        } catch (e) {}

        // On sauvegarde l'état avant la state machine
        const hadTask = !!this.currentTask;
        await this.runStateMachine(inv, summary);

        // Si une nouvelle tâche a été assignée, préparer l'enregistrement récompense
        if (this.currentTask && !this._pendingRecord && _stateBeforeDecision) {
            const actionName = this._inferActionName(this.currentTask);
            if (actionName) {
                this._pendingRecord = { input: _stateBeforeDecision, actionName };
            }
        }

        // Si la state machine a assigné une tâche, on l'exécute
        if (this.currentTask) return;

        // --- ÉTAPE 2 : La state machine n'a rien proposé, on consulte le Brain ---
        this.ticksSinceLastAiCheck = (this.ticksSinceLastAiCheck || 0) + 1;

        // Détection de stuck réelle : même stage depuis trop longtemps
        const consecutiveFailures = Object.values(this.failedTasks).reduce((a, b) => a + b, 0);
        const isStuck = consecutiveFailures > 5;

        if (isStuck || this.ticksSinceLastAiCheck > 100) {
            this.ticksSinceLastAiCheck = 0;

            const botState = {
                _bot: this.bot,
                stage: this.stage,
                failedTasks: JSON.stringify(this.failedTasks),
                isStuck: isStuck
            };

            const aiDecision = await this.brain.decideNextTask(botState);
            if (aiDecision && this.validateAiCommand(aiDecision)) {
                console.log(`[Agent-IA] Conseil IA accepté: ${aiDecision.action}`, aiDecision.args);
                try { this.bot.pathfinder.setGoal(null); } catch (e) {}
                this.bot.clearControlStates();
                this.executeAiCommand(aiDecision);
            }
        }

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

    // ==================== REWARD-BASED RECORDING ====================

    // Déduit le nom de l'action ACTIONS[] depuis l'instance de tâche
    _inferActionName(task) {
        const n = task.name;
        if (n === 'GetWood')       return 'GetWood';
        if (n === 'MoveToSurface') return 'MoveToSurface';
        if (n === 'DigDown')       return 'DigDown';

        if (n.startsWith('Mine_')) {
            const b = task.blockName || '';
            if (b.includes('iron'))    return 'MineIronOre';
            if (b.includes('coal'))    return 'MineCoal';
            if (b.includes('diamond')) return 'DigDown';
            if (b.includes('stone') || b.includes('cobble')) return 'MineStone';
            if (b.includes('obsidian')) return 'MineObsidian';
            if (b.includes('gravel'))  return 'MineGravel';
        }

        if (n.startsWith('Craft_') || n.startsWith('Smelt_')) {
            const item = task.itemName || task.outputItem || '';
            if (item.includes('planks'))         return 'CraftPlanks';
            if (item === 'crafting_table')        return 'CraftCraftingTable';
            if (item === 'stick')                 return 'CraftStick';
            if (item === 'wooden_pickaxe')        return 'CraftWoodenPickaxe';
            if (item === 'stone_pickaxe')         return 'CraftStonePickaxe';
            if (item === 'stone_sword')           return 'CraftStoneSword';
            if (item === 'furnace')               return 'CraftFurnace';
            if (item === 'iron_pickaxe')          return 'CraftIronPickaxe';
            if (item === 'iron_sword')            return 'CraftIronSword';
            if (item === 'iron_ingot')            return 'SmeltIron';
            if (item === 'flint_and_steel')       return 'CraftFlintAndSteel';
            if (item === 'blaze_powder')          return 'CraftBlazePowder';
            if (item === 'ender_eye')             return 'CraftEyeOfEnder';
        }

        if (n === 'FightMob') {
            const mob = task.mobType || '';
            if (mob === 'blaze')    return 'FightBlaze';
            if (mob === 'enderman') return 'FightEnderman';
        }

        return null;
    }

    _saveProgressionExample(actionName, input) {
        try {
            const { ACTIONS } = require('./Recorder');
            const datasetPath = require('path').join(__dirname, '../data/dataset.json');
            const idx = ACTIONS.indexOf(actionName);
            if (idx === -1) return;
            const output = new Array(ACTIONS.length).fill(0);
            output[idx] = 1;
            let dataset = [];
            if (require('fs').existsSync(datasetPath)) {
                dataset = JSON.parse(require('fs').readFileSync(datasetPath, 'utf-8'));
            }
            dataset.push({ input, output, action: actionName, reward: 1, timestamp: Date.now() });
            const tmp = datasetPath + '.tmp';
            require('fs').writeFileSync(tmp, JSON.stringify(dataset, null, 2));
            require('fs').renameSync(tmp, datasetPath);
            console.log(`[Agent] Récompense enregistrée: ${actionName} (total: ${dataset.length})`);
        } catch (e) {
            console.log(`[Agent] Erreur enregistrement récompense: ${e.message}`);
        }
    }

    // ==================== SURFACE CHECK ====================

    /**
     * Retourne une chaîne décrivant la raison de remonter à la surface,
     * ou null si le bot peut rester où il est.
     * N'est pas appelé pour NETHER, STRONGHOLD, END (underground intentionnel).
     */
    _requiresSurface(inv, has, count) {
        if (['NETHER', 'STRONGHOLD', 'END'].includes(this.stage)) return null;

        const y = this.bot.entity.position.y;
        if (y >= 60) return null; // déjà en surface

        // ── EARLY_GAME : pas de bois et pas d'arbre accessible à portée ─────────
        if (this.stage === 'EARLY_GAME') {
            const hasWood = inv.some(i => i.name.includes('log') || i.name.includes('planks'));
            if (!hasWood) {
                const treeNearby = this.bot.findBlock({
                    matching: b => b.name.includes('log') && !b.name.includes('stripped'),
                    maxDistance: 24
                });
                if (!treeNearby) return 'early_game_no_wood_underground';
            }
        }

        // ── IRON : du raw_iron à fondre mais pas de fourneau à portée ───────────
        if (this.stage === 'IRON') {
            const rawIron = inv.filter(i => i.name === 'raw_iron').reduce((a, b) => a + b.count, 0);
            if (rawIron >= 3) {
                const furnace = this.bot.findBlock({
                    matching: this.mcData.blocksByName.furnace?.id,
                    maxDistance: 32
                });
                if (!furnace) return 'iron_raw_iron_no_furnace';
            }

            // Ingots en main + besoin de crafter mais pas de table à portée
            if (count('iron_ingot') >= 3 && !has('iron_pickaxe')) {
                const table = this.bot.findBlock({
                    matching: this.mcData.blocksByName.crafting_table?.id,
                    maxDistance: 32
                });
                if (!table) return 'iron_craft_no_table';
            }
        }

        // ── DIAMOND : diamants en main, pioche non craftée, pas de table à portée
        if (this.stage === 'DIAMOND') {
            const diamonds = inv.filter(i => i.name === 'diamond').reduce((a, b) => a + b.count, 0);
            if (diamonds >= 3 && !has('diamond_pickaxe')) {
                const table = this.bot.findBlock({
                    matching: this.mcData.blocksByName.crafting_table?.id,
                    maxDistance: 32
                });
                if (!table) return 'diamond_craft_no_table';
            }
        }

        return null;
    }

    // ==================== STATE MACHINE ====================
    async runStateMachine(inv, summary) {
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
                this.stage = target;
            }
        };
        if (has('diamond_pickaxe')) atLeast('NETHER');
        else if (has('iron_pickaxe') && has('iron_sword')) atLeast('DIAMOND');
        else if (has('iron_pickaxe')) atLeast('IRON'); // reste en IRON pour crafter l'épée

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
        if ((hasEdible && this.bot.food < 16) || this.bot.food <= 6) {
            console.log(`[Agent] Faim ${this.bot.food}/20 -> GetFood (priorite vitale)`);
            this.currentTask = new GetFood(this.bot);
            return;
        }

        // ── Vérification générale : remonter à la surface si nécessaire ──────────
        const surfaceReason = this._requiresSurface(inv, has, count);
        if (surfaceReason) {
            console.log(`[Agent] Surface requise (${surfaceReason}) → MoveToSurface`);
            this.currentTask = new MoveToSurface(this.bot);
            return;
        }

        // ========== STAGE: EARLY_GAME ==========
        if (this.stage === 'EARLY_GAME') {
            const hasPick = has('stone_pickaxe');
            const hasSword = inv.some(i => i.name.includes('sword'));

            if (!hasPick || !hasSword) {
                if ((this.failedTasks['Craft_stone_pickaxe'] || 0) > 5 && has('wooden_pickaxe')) {
                    console.log("[Agent] Stone pickaxe craft failed multiple times, skipping to IRON stage with wooden pickaxe.");
                    this.stage = 'IRON';
                    return;
                }
                await this.handleEarlyGame(inv, has, count);
                return;
            }
            console.log("[Agent] Early game complete! Moving to IRON stage.");
            this.stage = 'IRON';
        }

        // ========== STAGE: IRON ==========
        if (this.stage === 'IRON') {
            if (!has('iron_pickaxe') || !has('iron_sword')) {
                await this.handleIronStage(inv, has, count);
                return;
            }
            console.log("[Agent] Iron stage complete! Moving to DIAMOND stage.");
            this.failedTasks = {}; // Reset des echecs en changeant d'etape
            this.stage = 'DIAMOND';
        }

        // ========== STAGE: DIAMOND ==========
        if (this.stage === 'DIAMOND') {
            if (!has('diamond_pickaxe')) {
                await this.handleDiamondStage(inv, has, count);
                return;
            }
            console.log("[Agent] Diamond stage complete! Moving to NETHER stage.");
            this.stage = 'NETHER';
        }

        // ========== STAGE: NETHER ==========
        if (this.stage === 'NETHER') {
            if (count('blaze_rod') < 6 || count('ender_pearl') < 12) {
                this.handleNetherStage(inv, has, count);
                return;
            }
            console.log("[Agent] Nether stage complete! Moving to STRONGHOLD stage.");
            this.stage = 'STRONGHOLD';
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
            this.stage = 'END';
        }

        // ========== STAGE: END (Fight Dragon) ==========
        if (this.stage === 'END') {
            this.handleEndStage(inv, has, count);
            return;
        }

        console.log("[Agent] VICTORY! Ender Dragon defeated!");
    }

    // ==================== VALIDATION IA ====================
    validateAiCommand(decision) {
        const { action, args } = decision;
        const inv = this.bot.inventory.items();
        const has = (name) => inv.some(i => i.name.includes(name));

        // Actions toujours autorisées
        if (action === 'GetWood' || action === 'MoveToSurface') return true;

        // MineBlock stone/ore : besoin d'une pioche
        if (action === 'MineBlock') {
            const blockName = args && args[0];
            if (blockName && (blockName.includes('stone') || blockName.includes('ore') || blockName.includes('diamond') || blockName.includes('obsidian'))) {
                if (!has('pickaxe')) {
                    console.log(`[Agent-IA] REJETÉ: MineBlock ${blockName} sans pioche`);
                    return false;
                }
            }
            return true;
        }

        // BuildNetherPortal : besoin d'obsidienne + flint
        if (action === 'BuildNetherPortal') {
            const obsCount = inv.filter(i => i.name === 'obsidian').reduce((a, b) => a + b.count, 0);
            if (obsCount < 10) {
                console.log(`[Agent-IA] REJETÉ: BuildNetherPortal avec ${obsCount}/10 obsidienne`);
                return false;
            }
            if (!has('flint_and_steel')) {
                console.log(`[Agent-IA] REJETÉ: BuildNetherPortal sans flint_and_steel`);
                return false;
            }
            return true;
        }

        // SmeltTask : besoin de fuel + input + furnace
        if (action === 'SmeltTask') {
            const hasFuel = inv.some(i => i.name.includes('coal') || i.name.includes('log') || i.name.includes('planks') || i.name.includes('charcoal'));
            if (!hasFuel) {
                console.log(`[Agent-IA] REJETÉ: SmeltTask sans fuel`);
                return false;
            }
            return true;
        }

        // FightMob : besoin d'une arme (sauf zombies)
        if (action === 'FightMob') {
            const mobType = args && args[0];
            if (mobType === 'blaze' || mobType === 'enderman') {
                if (!has('sword') && !has('axe')) {
                    console.log(`[Agent-IA] REJETÉ: FightMob ${mobType} sans arme`);
                    return false;
                }
            }
            return true;
        }

        // CraftTask : toujours autorisé (les vérifications sont dans CraftTask)
        return true;
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
                    console.log("[Agent] Need sticks but no planks! Going to GetWood.");
                    this.currentTask = new GetWood(this.bot, 3);
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
            this.stage = 'EARLY_GAME';
            return;
        }

        // Ensure backup stone pickaxe if we are deep down
        if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

        // 0. Recuperer le fer reste DANS LE FOUR (ex: fonte interrompue par un crash/restart)
        //    AVANT de re-miner. Sinon on ne compte que l'inventaire et on re-mine pour rien.
        //    Symptome : on a deja des lingots mais pas 6, et plus de minerai brut en main.
        //    Si le four est vide, SmeltTask echoue -> on tombe sur l'etape de minage.
        const smeltCollectName = 'Smelt_raw_iron_to_iron_ingot';

        //    Cas particulier : la fonte s'est arrêtée faute de combustible, le minerai est
        //    resté dans le four. On recharge en combustible et on y retourne.
        if (this._furnaceNeedsFuel && count('iron_ingot') < 6) {
            const hasFuel = inv.some(i => i.name === 'coal' || i.name === 'charcoal' ||
                i.name.includes('planks') || (i.name.includes('log') && !i.name.includes('stripped')));
            if (!hasFuel) {
                console.log("[Agent] Minerai bloqué dans le four sans combustible -> GetWood.");
                this.currentTask = new GetWood(this.bot, 2);
                return;
            }
            console.log("[Agent] Combustible récupéré -> retour au four.");
            this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 6);
            return;
        }

        if (count('iron_ingot') >= 1 && count('iron_ingot') < 6 && count('raw_iron') === 0
            && (this.failedTasks[smeltCollectName] || 0) === 0) {
            const furnaceNearby = this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace?.id,
                maxDistance: 16
            });
            if (furnaceNearby) {
                console.log("[Agent] Lingots manquants + four a proximite -> recuperation de la fonte avant de re-miner.");
                this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 6);
                return;
            }
        }

        // 1. Mine Iron Ore (need 6 for pickaxe + shield + sword)
        if (count('raw_iron') < 6 && count('iron_ingot') < 6) {
            // Si du minerai est déjà accessible à portée, le miner directement
            const ironIds = ['iron_ore', 'deepslate_iron_ore']
                .map(n => this.mcData.blocksByName[n]?.id)
                .filter(Boolean);
            const nearIron = ironIds.length > 0 && this.bot.findBlock({ matching: ironIds, maxDistance: 6 });
            if (nearIron) {
                console.log("Goal: Mine Iron Ore (nearby)");
                this.currentTask = new MineBlock(this.bot, 'iron_ore', 6);
                return;
            }
            // Le fer est plus dense à y=16 — descendre d'abord si on est trop haut
            if (this.bot.entity.position.y > 20) {
                console.log("Goal: Dig Down to iron level (y=16)");
                const DigDown = require('./tasks/DigDown');
                this.currentTask = new DigDown(this.bot, 16, ['iron_ore', 'deepslate_iron_ore']);
                return;
            }
            console.log("Goal: Mine Iron Ore");
            this.currentTask = new MineBlock(this.bot, 'iron_ore', 6);
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


        // 2. Craft Furnace (or skip if fails too many times OR if we already have 3 iron ingots)
        console.log(`[DEBUG] has(furnace): ${has('furnace')}, failed(Craft_furnace): ${this.failedTasks['Craft_furnace'] || 0}`);
        if (!has('furnace') && count('iron_ingot') < 6) {
            // Check if we already have a furnace placed nearby
            const nearbyFurnace = this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace?.id,
                maxDistance: 32
            });

            if (nearbyFurnace) {
                console.log("[DEBUG] Found placed furnace nearby, skipping craft.");
            } else {
                // Ensure we have a crafting table first (or wood to make one)
                await this.ensureTable(inv, has, count);
                if (this.currentTask) return;

                // If furnace craft failed more than 5 times AND we have a placed furnace nearby, skip
                if ((this.failedTasks['Craft_furnace'] || 0) > 5) {
                    const furnaceBlock = this.bot.findBlock({
                        matching: this.mcData.blocksByName.furnace?.id,
                        maxDistance: 64
                    });
                    if (furnaceBlock) {
                        console.log("[Agent] Furnace craft failed multiple times, but found placed furnace nearby. Continuing.");
                    } else {
                        console.log("[Agent] Furnace craft failed multiple times. Moving to surface to find better location.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return;
                    }
                } else {
                    if (count('cobblestone') < 8) {
                        // Descendre à y=30 pour trouver pierre + charbon en même temps
                        if (this.bot.entity.position.y > 35) {
                            console.log("Goal: Dig Down to stone level (y=30)");
                            const DigDown = require('./tasks/DigDown');
                            this.currentTask = new DigDown(this.bot, 30, ['coal_ore', 'deepslate_coal_ore']);
                            return;
                        }
                        console.log("Goal: Mine Cobblestone for Furnace");
                        this.currentTask = new MineBlock(this.bot, 'stone', 8);
                        return;
                    }
                    console.log("Goal: Craft Furnace");
                    console.log("[DEBUG] Setting task: Craft_furnace");
                    this.currentTask = new CraftTask(this.bot, 'furnace');
                    return;
                }
            }
        }

        // 3. Smelt Iron (target changed to 6 for all equipment)
        if (count('iron_ingot') < 6) {
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
                return;
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
                if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

                // 2. Try to find Coal Ore nearby
                const coalOre = this.bot.findBlock({
                    matching: ['coal_ore', 'deepslate_coal_ore'].map(name => this.mcData.blocksByName[name].id),
                    maxDistance: 32
                });

                if (coalOre) {
                    console.log("[Agent] Found Coal Ore nearby! Mining for fuel.");
                    this.currentTask = new MineBlock(this.bot, 'coal_ore', 3);
                    return;
                } else {
                    // Descendre à y=30 où le charbon est abondant
                    if (this.bot.entity.position.y > 35) {
                        console.log("Goal: Dig Down to coal level (y=30)");
                        const DigDown = require('./tasks/DigDown');
                        this.currentTask = new DigDown(this.bot, 30, ['coal_ore', 'deepslate_coal_ore']);
                        return;
                    }
                    console.log("[Agent] No Coal Ore found nearby. Checking surface/wood fallback.");
                    // If we are deep underground and no coal, we must surface.
                    if (this.bot.entity.position.y < 60) {
                        console.log("[Agent] Underground, no coal, no fuel. Returning to surface for wood/survival.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return;
                    }
                    // If on surface, get wood
                    console.log("[Agent] On surface (or close). getting wood for fuel.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
            }

            // CRITICAL: If we have fuel but are underground, GO TO SURFACE FIRST
            if (this.bot.entity.position.y < 60) {
                console.log("[Agent] Have fuel for smelting but UNDERGROUND! Moving to surface first.");
                this.currentTask = new MoveToSurface(this.bot);
                return;
            }

            this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 6);
            return;
        }

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
                } else {
                    console.log("Goal: Get Wood for Sticks (no logs in inventory)");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
            }
            console.log("Goal: Craft Sticks");
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        if (!has('iron_pickaxe')) {
            console.log("Goal: Craft Iron Pickaxe");
            this.currentTask = new CraftTask(this.bot, 'iron_pickaxe');
            return;
        }

        // Iron Sword crafting (after pickaxe)
        if (!has('iron_sword')) {
            // Besoin de 2 iron_ingots pour l'épée
            if (count('iron_ingot') < 2) {
                if (count('raw_iron') < 2) {
                    console.log("Goal: Mine more Iron for Sword");
                    this.currentTask = new MineBlock(this.bot, 'iron_ore', 2);
                    return;
                }
                console.log("Goal: Smelt Iron for Sword");
                this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 2);
                return;
            }

            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            if (count('stick') < 1) {
                if (count('planks') < 2) {
                    if (count('log') > 0) {
                        const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                        let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                        console.log(`Goal: Craft Planks for Iron Sword`);
                        this.currentTask = new CraftTask(this.bot, plankType, 1);
                        return;
                    }
                }
                console.log("Goal: Craft Stick for Iron Sword");
                this.currentTask = new CraftTask(this.bot, 'stick', 1);
                return;
            }

            console.log("Goal: Craft Iron Sword");
            this.currentTask = new CraftTask(this.bot, 'iron_sword');
            return;
        }
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
            if (this.bot.entity.position.y > 16) {
                console.log("Goal: Go Deep for Diamonds");
                const DigDown = require('./tasks/DigDown');
                this.currentTask = new DigDown(this.bot, -54, ['diamond_ore', 'deepslate_diamond_ore']);
                return;
            }

            console.log("Goal: Mine Diamonds");
            this.currentTask = new MineBlock(this.bot, 'diamond_ore', 3);
            return;
        }

        // Craft Diamond Pickaxe
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return;

        if (count('stick') < 2) {
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        console.log("Goal: Craft Diamond Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'diamond_pickaxe');
    }

    // ==================== NETHER STAGE ====================
    handleNetherStage(inv, has, count) {
        // 1. Get Obsidian (need 10)
        if (count('obsidian') < 10) {
            // Need bucket + water + lava, or mine directly
            console.log("Goal: Mine Obsidian");
            this.currentTask = new MineBlock(this.bot, 'obsidian', 10);
            return;
        }

        // 2. Craft Flint and Steel
        if (!has('flint_and_steel')) {
            if (!has('flint')) {
                console.log("Goal: Mine Gravel for Flint");
                this.currentTask = new MineBlock(this.bot, 'gravel', 5);
                return;
            }
            if (count('iron_ingot') < 1) {
                this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 1);
                return;
            }
            console.log("Goal: Craft Flint and Steel");
            this.currentTask = new CraftTask(this.bot, 'flint_and_steel');
            return;
        }

        // 3. Build Portal
        const portal = this.bot.findBlock({
            matching: this.mcData.blocksByName.nether_portal?.id,
            maxDistance: 64
        });
        if (!portal) {
            console.log("Goal: Build Nether Portal");
            this.currentTask = new BuildNetherPortal(this.bot);
            return;
        }

        // 4. Enter Nether & Find Blaze
        if (count('blaze_rod') < 6) {
            console.log("Goal: Hunt Blazes");
            this.currentTask = new FightMob(this.bot, 'blaze', 6);
            return;
        }

        // 5. Get Ender Pearls (from Endermen or Piglins)
        if (count('ender_pearl') < 12) {
            console.log("Goal: Get Ender Pearls");
            this.currentTask = new FightMob(this.bot, 'enderman', 12);
            return;
        }

        // 6. Craft Eyes of Ender
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
    async ensureTable(inv, has, count) {
        // Si le bot a une table en inventaire, préférer en poser une proche
        // plutôt que de marcher vers une table potentiellement bloquée par un autre bot
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        const tableBlock = this.bot.findBlock({
            matching: this.mcData.blocksByName.crafting_table.id,
            maxDistance: tableItem ? 4 : 10  // rayon réduit si on en a une en inventaire
        });

        // Table already placed nearby
        if (tableBlock) {
            console.log(`[DEBUG] ensureTable: Found table at ${tableBlock.position}`);
            return;
        }

        // Table in inventory, need to place it
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
        if (pickaxes.length >= 2) {
            this._redundancyAttempts = 0;
            return false;
        }

        this._redundancyAttempts++;
        if (this._redundancyAttempts > 3) {
            console.log(`[Agent] Redundancy: échec répété (${this._redundancyAttempts}), on passe.`);
            this._redundancyAttempts = 0;
            return false;
        }

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
        // Compter UNIQUEMENT cobblestone pur (pas cobbled_deepslate/blackstone car recette non mixable)
        const strictCobble = inv.filter(i => i.name === 'cobblestone').reduce((a, b) => a + b.count, 0);
        if (strictCobble < 3) {
            const hasPick = pickaxes.length > 0;
            if (hasPick) {
                console.log(`[Agent] Manque cobblestone pur pour backup (${strictCobble}/3) → Mine Stone`);
                this.currentTask = new MineBlock(this.bot, 'stone', 3);
                return true;
            } else {
                return false;
            }
        }

        // We have Sticks + Cobble. Need Table?
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return true;

        console.log("[Agent] Crafting backup Stone Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'stone_pickaxe', 2);
        return true;
    }

    // ==================== EXECUTION IA ====================
    executeAiCommand(decision) {
        const { action, args } = decision;
        try {
            switch (action) {
                case 'GetWood':
                    this.currentTask = new GetWood(this.bot, args[0] || 3);
                    break;
                case 'CraftTask':
                    this.currentTask = new CraftTask(this.bot, args[0], args[1] || 1);
                    break;
                case 'MineBlock':
                    this.currentTask = new MineBlock(this.bot, args[0], args[1] || 1);
                    break;
                case 'SmeltTask':
                    this.currentTask = new SmeltTask(this.bot, args[0], args[1], args[2] || 1);
                    break;
                case 'MoveToSurface':
                    this.currentTask = new MoveToSurface(this.bot);
                    break;
                case 'FightMob':
                    this.currentTask = new FightMob(this.bot, args[0], args[1] || 1);
                    break;
                case 'BuildNetherPortal':
                    this.currentTask = new BuildNetherPortal(this.bot);
                    break;
                default:
                    console.log(`[Agent-IA] Action inconnue fournie par l'IA: ${action}`);
            }
        } catch (err) {
            console.log(`[Agent-IA] Erreur lors de l'attribution de la tâche: ${err.message}`);
        }
    }
}

module.exports = Agent;
