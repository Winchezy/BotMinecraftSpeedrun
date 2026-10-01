const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { routeThreats, threatNearPath, threatNearPoint } = require('../lib/MobSafety');
const { planCompletePath } = require('../lib/Pathing');
const { safeExplorationPath, safeExplorationBreak } = require('../lib/ExplorationSafety');
const SmeltTask = require('./SmeltTask');
const CraftTask = require('./CraftTask');
const GetWood = require('./GetWood');
const MineBlock = require('./MineBlock');
const MoveToSurface = require('./MoveToSurface');
const { isAtSurface } = require('../lib/Trail');
const COOKED = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', chicken: 'cooked_chicken' };

// Aliments mangeables. On accepte le cru SUR uniquement (boeuf/porc/mouton/lapin/
// poisson ne donnent aucun effet negatif). On EXCLUT le poulet cru (effet Hunger ~30%)
// et la chair putrefiee : pas d'empoisonnement. Le poulet CUIT reste autorise.
const EDIBLE = [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
    'cooked_cod', 'cooked_salmon', 'bread', 'apple', 'golden_apple', 'baked_potato',
    'carrot', 'melon_slice', 'glow_berries', 'sweet_berries', 'beetroot', 'potato', 'dried_kelp',
    'mushroom_stew', 'rabbit_stew', 'pumpkin_pie', 'cookie', 'beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon'
];
// Animaux passifs a chasser (pas le poulet : on ne mangerait pas sa viande crue).
const PREY = ['cow', 'pig', 'sheep', 'rabbit', 'mooshroom', 'chicken'];

class GetFood extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'GetFood';
        this.mcData = require('minecraft-data')(bot.version);
        this.searchMoves = 0;
        this.memory = bot.foodSearchMemory ||= new (require('../lib/FoodSearchMemory'))(bot);
        this.mushrooms = new (require('../lib/MushroomFood'))(bot, this.memory);
        this.searchArea = bot.foodSearchArea ||= {radius:32,scans:0,lastExpansion:0};
        this.farming = bot.wheatFarm ||= new (require('../lib/WheatFarm'))(bot);
    }

    findEdible() {
        const items = this.bot.inventory.items();
        return items.find(i => EDIBLE.includes(i.name) && !COOKED[i.name]) ||
            undefined;
    }

    async run() {
        const decision = require('../lib/SurvivalPolicy').decideActivity(this.bot);
        if (decision.activity === 'combat' || decision.activity === 'escape') return;
        // Ready food takes precedence over starting/continuing furnace preparation.
        const readyFood = this.findEdible();
        if (readyFood && this.bot.food >= 20) { this.complete(); return; }
        if (readyFood && this.bot.food < 20) {
            this.bot.survivalDecision = {activity:'eat',reason:'nourriture disponible'};
            await this.bot.equip(readyFood, 'hand');
            await this.bot.consume();
            this.farming.foodFound();
            return;
        }
        if (this.bot.food===0 && Date.now()-(this.bot.lastFoodDiagnostic||0)>60000) {
            this.bot.lastFoodDiagnostic=Date.now();
            console.log(`[GetFood] Famine : vie=${this.bot.health}, inventaire=${this.bot.inventory.items().map(i=>`${i.name}x${i.count}`).join(',')}`);
        }
        if (this.bot.food <= 6) {
            const ready = this.findEdible();
            const immediateDanger = this.bot.isInCombat?.() ||
                (this.bot.entity?.position && threatNearPoint(this.bot,this.bot.entity.position,2)) ||
                (this.bot.food===0 && Date.now()-(this.bot.lastStarvationDamage||0)<10000);
            const rawEmergency = immediateDanger && this.bot.inventory.items().find(i => ['beef','porkchop','mutton','rabbit','cod','salmon'].includes(i.name));
            const lastResort = this.bot.health<=4 && !ready && !this.bot.inventory.items().some(i=>COOKED[i.name]) &&
                this.bot.inventory.items().find(i=>i.name==='rotten_flesh');
            const emergency = ready || rawEmergency || lastResort;
            if (emergency) {
                this.bot.chat?.(ready ? '[SpeedBot] Faim critique : je mange tout de suite.' :
                    rawEmergency ? '[SpeedBot] Faim critique : une portion crue pour survivre, puis cuisson du reste.' :
                    '[SpeedBot] Famine et vie critique : chair putrefiee en dernier recours, puis recherche de nourriture normale.');
                await this.bot.equip(emergency, 'hand');
                await this.bot.consume();
                this.farming.foodFound();
                this.searchArea.radius=32;this.searchArea.scans=0;
                return;
            }
        }
        if (this.cooking && !this.cooking.isDone()) {
            await this.cooking.run();
            if (!this.cooking.isDone()) return;
            if (this.cooking.hasFailed) this.cookingFailed = true;
        }
        if (this.preparation) {
            await this.preparation.run();
            if (!this.preparation.isDone()) return;
            if (this.preparation.hasFailed) { this.fail('Preparation de cuisson impossible'); return; }
            this.preparation = null;
        }
        const items = this.bot.inventory.items();
        const raw = items.find(i => COOKED[i.name]);
        if (raw || this.findEdible()) this.farming.foodFound();
        const fuel = items.some(i => /^(coal|charcoal|stick)$|_log$|_planks$/.test(i.name));
        // Cuire avant de manger, sauf urgence ou absence de moyens de cuisson.
        if (raw && !this.cookingFailed) {
            if (!fuel) {
                this.bot.chat?.('[SpeedBot] Viande crue : je recupere du combustible avant de la cuire.');
                this.preparation = new GetWood(this.bot, 2);
                return;
            }
            const furnace = items.some(i => i.name === 'furnace') || this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace.id, maxDistance: 32
            });
            if (!furnace && items.filter(i => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(i.name)).reduce((n, i) => n + i.count, 0) < 8) {
                this.preparation = new MineBlock(this.bot, 'stone', 8);
                return;
            }
            if (!furnace && !items.some(i => i.name === 'crafting_table') && !this.bot.findBlock({
                matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 4
            })) {
                const planks = items.filter(i => i.name.endsWith('_planks')).reduce((n, i) => n + i.count, 0);
                const log = items.find(i => i.name.endsWith('_log'));
                this.preparation = planks >= 4 ? new CraftTask(this.bot, 'crafting_table') :
                    log ? new CraftTask(this.bot, log.name.replace('_log', '_planks'), 4) : new GetWood(this.bot, 2);
                return;
            }
            if (!furnace) {
                this.cookPreparation ||= new CraftTask(this.bot, 'furnace');
                await this.cookPreparation.run();
                if (!this.cookPreparation.isDone()) return;
                if (this.cookPreparation.hasFailed) this.cookingFailed = true;
                else return;
            } else if (furnace) {
                if (!this.cooking || this.cooking.isDone()) {
                    const alreadyCooked = items.filter(i=>i.name===COOKED[raw.name]).reduce((n,i)=>n+i.count,0);
                    this.cooking = new SmeltTask(this.bot, raw.name, COOKED[raw.name], alreadyCooked + Math.min(raw.count, 3));
                    this.bot.chat?.(`[SpeedBot] Cuisson de ${raw.name} avant consommation.`);
                }
                await this.cooking.run();
                if (!this.cooking.isDone()) return;
                if (this.cooking.hasFailed) this.cookingFailed = true;
            }
        }
        // 1. On a de quoi manger -> manger jusqu'a (presque) rassasie.
        if (this.findEdible()) {
            this.searchArea.radius=32;
            this.searchArea.scans=0;
            try {
                let guard = 0;
                while (this.bot.food < 20 && guard < 8) {
                    const food = this.findEdible();
                    if (!food) break;
                    if (this.bot.heldItem?.name !== food.name) await this.bot.equip(food, 'hand');
                    await this.bot.consume();
                    guard++;
                }
                console.log(`[GetFood] Mange. Faim: ${this.bot.food}/20`);
            } catch (e) {
                console.log(`[GetFood] Echec en mangeant: ${e.message}`);
            }
            this.complete();
            return;
        }

        // 2. Pas de nourriture -> chasser un animal proche.
        if (await this.collectFoodDrop()) return;
        if (await this.mushrooms.run()) return;
        const candidates = Object.values(this.bot.entities || {})
            .filter(e => e?.position && PREY.includes((e.name || '').toLowerCase()) &&
                e.position.distanceTo(this.bot.entity.position) < this.searchArea.radius)
            .sort((a, b) => a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position));
        let prey = null;
        for (const animal of candidates.slice(0, 12)) {
            if (!this.memory.allowed(this.bot.entity.position, animal.position, false)) continue;
            if (routeThreats(this.bot).some(entity =>
                Math.abs(entity.position.y - animal.position.y) < 5 &&
                (entity.position.distanceTo(animal.position) < 16 ||
                    entity.position.distanceTo(this.bot.entity.position) < 16))) continue;
            const route = await planCompletePath(
                this.bot,
                new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2)
            );
            if (route.status === 'success' && !threatNearPath(this.bot, route.path)) {
                prey = animal;
                break;
            }
            this.memory.markBlocked(this.bot.entity.position, animal.position, route.status);
        }
        if (!prey) {
            if (await this.harvestBerries()) return;
            if (await this.farming.run()) return;
            const lastSearch = this.bot.lastFoodPastureSearch;
            if ((!lastSearch || Date.now()-lastSearch.time > 20000 ||
                this.bot.entity.position.distanceTo(lastSearch.position) >= 12) &&
                await this.searchForPasture()) return;
            if (await this.exploreNearbyGround()) return;
            // Sous un couvert d'arbres, la faible lumiere du ciel ne prouve pas
            // que le bot est en grotte. Ne pas reconstruire la pile descendue.
            const recentlyDescended = Date.now() - (this.bot.lastFoodPillarDescent || 0) < 300000;
            if (this.bot.blockAt && !recentlyDescended && !isAtSurface(this.bot)) {
                this.foodAscent ||= new MoveToSurface(this.bot);
                if (!this.announcedAscent) {
                    this.bot.chat?.('[SpeedBot] Rien a manger dans la grotte : retour vers la surface pour me nourrir.');
                    this.announcedAscent = true;
                }
                await this.foodAscent.run();
                if (!this.foodAscent.hasFailed) return;
            }
            console.log(`[GetFood] Aucun animal accessible sans danger dans un rayon de ${this.searchArea.radius} blocs.`);
            this.fail(candidates.length ? 'Zone de nourriture dangereuse' : "Pas d'animal proche");
            return;
        }

        console.log(`[GetFood] Chasse: ${prey.name} a ${prey.position.floored()}`);
        this.farming.foodFound();
        const weapon = this.bot.inventory.items().find(i => i.name.includes('sword'))
            || this.bot.inventory.items().find(i => i.name.includes('axe'));
        if (weapon) { try { await this.bot.equip(weapon, 'hand'); } catch (e) { } }

        const deathPos = prey.position.clone();
        try {
            if (this.bot.pvp) this.bot.pvp.attack(prey);
            let t = 0;
            while (prey.isValid && t < 100) { // ~10s max
                deathPos.set(prey.position.x, prey.position.y, prey.position.z);
                await this.bot.waitForTicks(2);
                t++;
            }
            if (this.bot.pvp) this.bot.pvp.stop();
        } catch (e) {
            console.log(`[GetFood] Combat: ${e.message}`);
            try { if (this.bot.pvp) this.bot.pvp.stop(); } catch (_) { }
        }

        // Aller ramasser les drops (marcher sur la zone de mort).
        try {
            await Promise.race([
                this.bot.pathfinder.goto(new goals.GoalNear(deathPos.x, deathPos.y, deathPos.z, 1)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('pickup timeout')), 8000))
            ]);
        } catch (e) { }
        await this.bot.waitForTicks(10);

        // Garder la tache active : les drops doivent etre cuits au prochain tick.
    }

    async harvestBerries() {
        if (!this.bot.findBlock) return false;
        const berryIds = ['cave_vines', 'cave_vines_plant', 'sweet_berry_bush'].map(n => this.mcData.blocksByName[n]?.id).filter(n => n != null);
        const plant = this.bot.findBlock({ matching: berryIds, maxDistance: this.searchArea.radius,
            useExtraInfo: block => block.getProperties?.().berries === true ||
                (block.name === 'sweet_berry_bush' && block.getProperties?.().age >= 2) });
        if (!plant || threatNearPath(this.bot, [plant.position])) return false;
        const goal = new goals.GoalLookAtBlock(plant.position, this.bot.world, { reach: 3 });
        const route = await planCompletePath(this.bot, goal);
        if (route.status !== 'success' || threatNearPath(this.bot, route.path)) return false;
        try {
            const { withTimeout } = require('../lib/Pathing');
            await withTimeout(this.bot, this.bot.pathfinder.goto(goal), 8000, 'Baies inaccessibles');
            this.bot.chat?.('[SpeedBot] Je recolte des baies pour manger.');
            await this.bot.activateBlock(plant);
            await this.bot.waitForTicks(10);
            const drop = this.bot.nearestEntity?.(e => e.name === 'item' && e.position.distanceTo(plant.position) < 4);
            if (drop) await withTimeout(this.bot, this.bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)), 5000, 'Ramassage de baies bloque');
            return true;
        } catch (error) { console.log(`[GetFood] ${error.message}`); return false; }
    }

    async collectFoodDrop() {
        const bot=this.bot;
        if (!bot.entity?.position || !bot.registry || !bot.pathfinder) return false;
        const drops=Object.values(bot.entities||{}).filter(entity=>{
            if (entity.name!=='item' || !entity.position || entity.position.distanceTo(bot.entity.position)>24) return false;
            const item=entity.getDroppedItem?.();
            return item && (EDIBLE.includes(item.name) || COOKED[item.name]);
        }).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
        const {existingPassageMovements,withTimeout}=require('../lib/Pathing');
        if (!drops.length) return false;
        const original=bot.pathfinder.movements;
        const walking=existingPassageMovements(bot);
        for (const drop of drops.slice(0,4)) {
            const goal=new goals.GoalNear(drop.position.x,drop.position.y,drop.position.z,1);
            const route=await planCompletePath(bot,goal,600,walking);
            if (route.status!=='success' || threatNearPath(bot,route.path)) continue;
            try {
                bot.pathfinder.setMovements(walking);
                await withTimeout(bot,bot.pathfinder.goto(goal),6000,'Nourriture au sol inaccessible');
                await bot.waitForTicks(5);
                return true;
            } catch(error) {console.log(`[GetFood] ${error.message}`);}
            finally {bot.pathfinder.setMovements(original);}
        }
        return false;
    }

    async exploreNearbyGround() {
        const bot = this.bot;
        if (!bot.registry || !bot.blockAt || bot.isInCombat?.()) return false;
        const { existingPassageMovements, withTimeout } = require('../lib/Pathing');
        const walking = existingPassageMovements(bot);
        walking.canDig = true;
        walking.safeToBreak = block => safeExplorationBreak(bot,block);
        // Chercher un detour SUR, plutot que rejeter ensuite le plus court
        // trajet expose au vide sans jamais examiner les alternatives.
        const neighbors = walking.getNeighbors.bind(walking);
        walking.getNeighbors = node => neighbors(node).filter(next =>
            require('../lib/ExplorationSafety').safeExplorationStep(bot,next));
        const original = bot.pathfinder.movements;
        const origin = bot.entity.position.floored();
        const visited = bot.foodLocalVisits ||= new Map();
        for (const [key, expiry] of visited) if (expiry < Date.now()) visited.delete(key);
        visited.set(origin.toString(), Date.now()+60000);
        const visitedPoints = [...visited.keys()].map(key=>key.replace(/[()]/g,'').split(',').map(Number));
        const candidates = [];
        for (let x=-12;x<=12;x++) for (let z=-12;z<=12;z++) {
            if (Math.hypot(x,z)<1 || Math.hypot(x,z)>12) continue;
            for (let y=-8;y<=6;y++) {
                const target = origin.offset(x,y,z);
                if (this.farming?.explorationAllowed(target) === false) continue;
                const floor = bot.blockAt(target.offset(0,-1,0));
                const feet = bot.blockAt(target);
                const head = bot.blockAt(target.offset(0,1,0));
                const nearVisited = visitedPoints.some(([vx,vy,vz]) => {
                    // Le voisin du point de depart est une sortie possible,
                    // pas une zone deja parcourue. Garder les autres visites.
                    if (vx === origin.x && vy === origin.y && vz === origin.z) return false;
                    return Math.abs(vy-target.y)<2 && Math.hypot(vx-target.x,vz-target.z)<2;
                });
                if (nearVisited || target.distanceTo(origin)>6 && !this.memory.allowed(origin,target) || floor?.boundingBox !== 'block' ||
                    feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' ||
                    /water|lava|fire|magma|cactus/.test(floor.name+feet.name+head.name)) continue;
                candidates.push(target);
            }
        }
        const layers = new Map();
        for (const target of candidates) {
            if (!layers.has(target.y)) layers.set(target.y,[]);
            layers.get(target.y).push(target);
        }
        const groups = [...layers.entries()].sort((a,b)=>a[0]-b[0]).map(([,points])=>
            points.sort((a,b)=>this.explorationScore(b,origin)-this.explorationScore(a,origin)));
        const ordered = [];
        for (let depth=0;groups.some(group=>depth<group.length);depth++)
            for (const group of groups) if (group[depth]) ordered.push(group[depth]);
        const descentTargets = candidates.filter(target => {
            const floor = bot.blockAt(target.offset(0,-1,0));
            return floor?.name.endsWith('_log') && bot.blockAt(target.offset(0,-2,0))?.boundingBox === 'block';
        });
        ordered.unshift(...descentTargets);
        const safeNearby = candidates.filter(target => target.distanceTo(origin) <= 4 &&
            require('../lib/ExplorationSafety').safeExplorationStep(bot,target))
            .sort((a,b) => a.distanceTo(origin)-b.distanceTo(origin));
        ordered.unshift(...safeNearby);
        let rejectedDiagnostics = 0;
        for (const target of ordered.slice(0,48)) {
            const goal = new goals.GoalBlock(target.x,target.y,target.z);
            const route = await planCompletePath(bot,goal,500,walking);
            if (route.status !== 'success') continue;
            if (!safeExplorationPath(bot,route.path)) {
                const unsafeStep = route.path.find(step => !require('../lib/ExplorationSafety').safeExplorationStep(bot,step));
                if (await require('../lib/ExplorationSafety').supportExplorationEdge(bot,unsafeStep)) return true;
                if (rejectedDiagnostics++ < 3) {
                    const bad = route.path.find(step => !require('../lib/ExplorationSafety').safeExplorationStep(bot,step));
                    if (bad) {
                        const p = new (require('vec3').Vec3)(Math.floor(bad.x),Math.floor(bad.y),Math.floor(bad.z));
                        const terrain = [[0,0],[1,0],[-1,0],[0,1],[0,-1]].map(([x,z]) => ({x,z,
                            blocks: [-2,-1,0,1].map(y => bot.blockAt(p.offset(x,y,z))?.name)}));
                        console.log(`[GetFood] Route refusee: ${JSON.stringify({target,step:{x:bad.x,y:bad.y,z:bad.z,parkour:bad.parkour,toPlace:bad.toPlace,toBreak:bad.toBreak},terrain})}`);
                    }
                }
                continue;
            }
            if (threatNearPath(bot,route.path)) continue;
            try {
                bot.pathfinder.setMovements(walking);
                bot.isFoodExploring = true;
                console.log(`[GetFood] Exploration locale de ${origin} vers ${target}.`);
                if (Date.now() - (bot.lastFoodLocalNotice || 0) >= 60000) {
                    bot.lastFoodLocalNotice = Date.now();
                    bot.chat?.('[SpeedBot] Aucun trajet lointain : je cherche un passage proche pour explorer.');
                }
                const monitor=this.watchForFood();
                try {await withTimeout(bot,Promise.race([bot.pathfinder.goto(goal),monitor.promise]),15000,'Exploration locale bloquee');}
                finally {monitor.stop();}
                visited.set(bot.entity.position.floored().toString(),Date.now()+60000);
                bot.foodExplorationDirection = {x:target.x-origin.x,z:target.z-origin.z};
                return true;
            } catch (error) { visited.set(target.toString(),Date.now()+60000); }
            finally { bot.isFoodExploring=false; bot.clearControlStates(); bot.pathfinder.setMovements(original); }
        }
        const surroundings = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].map(([x,y,z])=>
            `${x},${y},${z}:${bot.blockAt(origin.offset(x,y,z))?.name}`);
        console.log(`[GetFood] Passage local introuvable a ${origin}; ${surroundings.join(' ')}; ${candidates.length} destinations.`);
        if (bot.blockAt(origin.offset(0,-1,0))?.name.endsWith('_leaves')) {
            const escape=bot.foodLeafEscape ||= new (require('../lib/DeathRecovery'))(bot);
            const direction=bot.foodExplorationDirection || {x:1,z:0};
            if (await escape.stepOffLeaf(origin.offset(direction.x,0,direction.z))) return true;
        }
        return false;
    }

    explorationScore(target, origin) {
        const dx = target.x-origin.x, dz = target.z-origin.z;
        const distance = Math.hypot(dx,dz);
        const heading = this.bot.foodExplorationDirection;
        const alignment = heading ? (dx*heading.x+dz*heading.z)/(distance*Math.hypot(heading.x,heading.z)||1) : 0;
        return distance + alignment*4 - Math.max(0,target.y-origin.y)*6;
    }

    expandSearch() {
        const state=this.searchArea;
        if (++state.scans>=2 && Date.now()-state.lastExpansion>=10000) {
            state.radius=Math.min(128,state.radius+32);
            state.lastExpansion=Date.now();state.scans=0;
            console.log(`[GetFood] Rayon de recherche : ${state.radius} blocs; zones traversees evitees pendant 60 s.`);
        }
        return state.radius;
    }

    watchForFood() {
        const bot=this.bot;
        const initial=new Map(Object.values(bot.entities||{}).filter(e=>e.position).map(e=>[e.id,e.position.distanceTo(bot.entity.position)]));
        let timer;
        const promise=new Promise(resolve=>{
            timer=setInterval(()=>{
                const found=Object.values(bot.entities||{}).find(entity=>{
                    if (!entity.position || entity.position.distanceTo(bot.entity.position)>24 ||
                        threatNearPoint(bot,entity.position,2)) return false;
                    const item=entity.getDroppedItem?.();
                    const edible=PREY.includes(entity.name) || item && (EDIBLE.includes(item.name)||COOKED[item.name]);
                    return edible && (!initial.has(entity.id) || entity.position.distanceTo(bot.entity.position)<initial.get(entity.id)-6);
                });
                if (!found) return;
                clearInterval(timer);
                console.log(`[GetFood] Nouvelle source reperee pendant la marche : ${found.name}.`);
                resolve();
                bot.pathfinder.setGoal(null);
                bot.clearControlStates?.();
            },300);
        });
        return {promise,stop:()=>clearInterval(timer)};
    }

    async searchForPasture() {
        const origin = this.bot.entity.position;
        // Descendre une pile avant d'explorer : chaque retrait exige un support
        // solide immediatement dessous, donc aucune chute de plusieurs blocs.
        if (await this.mushrooms.lowerPillar(origin.offset(0,-4,0))) return true;
        this.bot.lastFoodPastureSearch = {position:origin.clone(),time:Date.now()};
        const searchRadius=this.expandSearch();
        this.searchMoves++;
        this.memory.markVisited(origin);
        const groundIds = ['grass_block', 'dirt', 'coarse_dirt']
            .map(name => this.mcData.blocksByName[name]?.id).filter(id => id != null);
        const positions = this.bot.findBlocks({
            matching: groundIds,
            useExtraInfo: block => {
                if (!block?.position) return false;
                if (!this.memory.allowed(origin, block.position.offset(0,1,0))) return false;
                const feet = this.bot.blockAt(block.position.offset(0, 1, 0));
                const head = this.bot.blockAt(block.position.offset(0, 2, 0));
                return feet?.boundingBox === 'empty' && head?.boundingBox === 'empty';
            },
            maxDistance: searchRadius,
            count: 512
        });
        // Alterner les directions au lieu d'epuiser les sols les plus proches.
        const directions = Array.from({length:8},()=>[]);
        for (const floor of positions) {
            const angle = Math.atan2(floor.z-origin.z,floor.x-origin.x);
            const direction = Math.floor((angle+Math.PI)/(Math.PI/4)) % 8;
            directions[direction].push(floor);
        }
        for (const group of directions) group.sort((a,b)=>
            Math.abs(a.distanceTo(origin)-24)-Math.abs(b.distanceTo(origin)-24));
        const ordered = [];
        for (let depth=0; directions.some(group=>depth<group.length);depth++) {
            for (let n=0;n<8;n++) {
                const group = directions[(n+this.searchMoves)%8];
                if (group[depth]) ordered.push(group[depth]);
            }
        }
        let walkable = 0;
        let planned = 0;
        const routeStatuses = {};
        const sectors = new Set();
        for (const floorPos of ordered) {
            const target = floorPos.offset(0, 1, 0);
            if (this.farming?.explorationAllowed(target) === false) continue;
            if (!this.memory.allowed(origin, target)) continue;
            const distance = target.distanceTo(origin);
            // Le calculateur est borne a 32 blocs : avancer par etapes vers
            // les nouveaux secteurs, meme si l'observation porte plus loin.
            if (distance < 8 || distance > 30) continue;
            const feet = this.bot.blockAt(target);
            const head = this.bot.blockAt(target.offset(0, 1, 0));
            if (feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty') continue;
            walkable++;
            if (routeThreats(this.bot).some(entity =>
                Math.abs(entity.position.y - target.y) < 5 && entity.position.distanceTo(target) < 16)) continue;
            const sector = `${Math.floor(target.x / 4)},${Math.floor(target.z / 4)}`;
            if (sectors.has(sector)) continue;
            sectors.add(sector);
            if (planned++ >= 12) break;
            const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
            const route = await planCompletePath(this.bot, goal);
            routeStatuses[route.status] = (routeStatuses[route.status] || 0) + 1;
            if (route.status !== 'success' || !safeExplorationPath(this.bot,route.path) || threatNearPath(this.bot, route.path)) {
                this.memory.markBlocked(origin, target, route.status === 'success' ? 'danger' : route.status);
                continue;
            }
            console.log(`[GetFood] Recherche d'animaux vers ${target}.`);
            let timeout;
            const monitor=this.watchForFood();
            try {
                this.bot.isFoodExploring = true;
                await Promise.race([
                    this.bot.pathfinder.goto(goal),
                    monitor.promise,
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('Trajet trop long')), 15000);
                    })
                ]);
                this.memory.markVisited(this.bot.entity.position);
                return true;
            } catch (error) {
                console.log(`[GetFood] Exploration interrompue: ${error.message}`);
                this.memory.markBlocked(origin, target, 'timeout');
                try { this.bot.pathfinder.stop(); } catch (_) { }
                return this.searchMoves < 3;
            } finally {
                this.bot.isFoodExploring = false;
                this.bot.clearControlStates?.();
                clearTimeout(timeout);
                monitor.stop();
            }
        }
        console.log(`[GetFood] Exploration: ${positions.length} sols, ${walkable} positions libres, ${planned} trajets examines, statuts=${JSON.stringify(routeStatuses)}.`);
        return false;
    }
}

module.exports = GetFood;
