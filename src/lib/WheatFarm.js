const fs = require('node:fs');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { existingPassageMovements, planCompletePath, withTimeout } = require('./Pathing');
const { safeExplorationPath } = require('./ExplorationSafety');
const { threatNearPoint, threatNearPath } = require('./MobSafety');
const CraftTask = require('../tasks/CraftTask');
const GetWood = require('../tasks/GetWood');

class WheatFarm {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.now = options.now || Date.now;
        this.delay = options.delay ?? 120000;
        this.records = {};
        if (bot.username && options.persist !== false) {
            this.filename = path.resolve('.bot-state', `farm-${bot.username.replace(/[^a-z0-9_-]/gi,'_')}.json`);
            try { this.records = JSON.parse(fs.readFileSync(this.filename,'utf8')); } catch (_) {}
        }
    }

    state() {
        const bot = this.bot;
        const key = `${bot._client?.socket?.remoteAddress}:${bot._client?.socket?.remotePort}:${bot.game?.dimension || 'overworld'}`;
        return this.records[key] ||= { missingSince: null, plots: [], checkedAt: 0 };
    }

    save() {
        if (!this.filename) return;
        fs.mkdirSync(path.dirname(this.filename), { recursive: true });
        fs.writeFileSync(this.filename+'.tmp',JSON.stringify(this.records));
        fs.renameSync(this.filename+'.tmp',this.filename);
    }

    foodFound() { this.state().missingSince = null; this.save(); }
    noteMissing() {
        const state = this.state();
        if (state.missingSince === null) { state.missingSince = this.now(); this.save(); }
    }
    explorationAllowed(target) {
        const plots = this.state().plots;
        if (!plots.length) return true;
        const distance = point => Math.min(...plots.map(p=>point.distanceTo(new Vec3(p.x,p.y,p.z))));
        // Garder les cultures chargees et pouvoir revenir les recolter.
        return distance(target) <= 32 || distance(target) < distance(this.bot.entity.position);
    }
    count(name) { return this.bot.inventory.items().filter(i => i.name === name).reduce((n,i) => n+i.count,0); }
    item(name) { return this.bot.inventory.items().find(i => i.name === name); }
    announce(phase, message) {
        this.bot.foodFarmingStatus = phase;
        if (this.phase === phase && this.now() - (this.noticeAt || 0) < 60000) return;
        this.phase = phase; this.noticeAt = this.now();
        console.log(`[WheatFarm] ${message}`);
        this.bot.chat?.(`[SpeedBot] ${message}`);
    }

    illuminated(block) {
        return Math.max(block?.light || 0, (block?.skyLight || 0) - (this.bot.time?.isDay === false ? 11 : 0)) >= 9;
    }

    irrigated(position) {
        for (let x=-4;x<=4;x++) for (let z=-4;z<=4;z++) for (const y of [0,1]) {
            if (this.bot.blockAt(position.offset(x,y,z))?.name === 'water') return true;
        }
        return false;
    }

    safe(position) {
        return !this.bot.isInCombat?.() && !threatNearPoint(this.bot,position,3) &&
            !threatNearPoint(this.bot,this.bot.entity.position,3);
    }

    async approach(position, pickup = false) {
        const bot = this.bot;
        if (!this.safe(position)) return false;
        if (!pickup && bot.entity.position.distanceTo(position) <= 3 && bot.canSeeBlock?.(bot.blockAt(position))) return true;
        const original = bot.pathfinder.movements;
        const walking = existingPassageMovements(bot);
        walking.allowSprinting = false; walking.maxDropDown = 1;
        // Ne pas sauter sur le champ ou pietiner les plants pour les atteindre.
        const farmland = bot.registry.blocksByName.farmland?.id;
        walking.blocksToAvoid = new Set(walking.blocksToAvoid);
        if (farmland != null) walking.blocksToAvoid.add(farmland);
        const goal = pickup ? new goals.GoalNear(position.x,position.y,position.z,1) :
            new goals.GoalLookAtBlock(position,bot.world,{reach:3});
        const route = await planCompletePath(bot,goal,800,walking);
        if (route.status !== 'success' || route.path?.length && !safeExplorationPath(bot,route.path) || threatNearPath(bot,route.path)) return false;
        try {
            bot.pathfinder.setMovements(walking);
            await withTimeout(bot,bot.pathfinder.goto(goal),8000,'Acces au champ');
            return this.safe(position) && (pickup || bot.entity.position.distanceTo(position) <= 3.5);
        } finally { bot.pathfinder.setMovements(original); }
    }

    async prepareToolOrTable(needsHoe) {
        const bot = this.bot;
        if (this.preparation) {
            await this.preparation.run();
            if (this.preparation.isDone()) {
                if (this.preparation.hasFailed) this.retryAt = this.now()+30000;
                this.preparation = null;
            }
            return true;
        }
        const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'));
        const table = this.count('crafting_table') || bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 3 });
        if ((!needsHoe || hoe) && table) return false;
        const planks = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((n,i)=>n+i.count,0);
        const log = bot.inventory.items().find(i => i.name.endsWith('_log'));
        if (planks < 8 && (!hoe || !table)) this.preparation = log ?
            new CraftTask(bot,log.name.replace('_log','_planks'),8) : new GetWood(bot,2);
        else if (needsHoe && !hoe && this.count('stick') < 2) this.preparation = new CraftTask(bot,'stick',2);
        else if (!table) this.preparation = new CraftTask(bot,'crafting_table');
        else if (needsHoe && !hoe) this.preparation = new CraftTask(bot,this.count('cobblestone') >= 2 ? 'stone_hoe' : 'wooden_hoe');
        if (this.preparation) { this.announce('tools','Nourriture introuvable : je prepare une houe et un etabli pour cultiver du ble.'); return true; }
        return false;
    }

    async collectSeeds() {
        const bot = this.bot;
        const seedPlants = ['short_grass','grass','tall_grass','fern','large_fern'];
        const ids = seedPlants.map(name=>bot.registry.blocksByName[name]?.id).filter(id=>id != null);
        if (!ids.length) return false;
        const positions = bot.findBlocks({matching:ids,maxDistance:24,count:24});
        for (const position of positions.slice(0,8)) {
            const block = bot.blockAt(position);
            if (!seedPlants.includes(block?.name) || !this.safe(position) || !await this.approach(position)) continue;
            this.announce('seeds','Je recolte des graines dans l herbe pour semer du ble.');
            if (!bot.canDigBlock(block)) continue;
            await withTimeout(bot,bot.dig(block),4000,'Collecte de graines');
            await bot.waitForTicks(4);
            await this.approach(position,true);
            await bot.waitForTicks(4);
            return true;
        }
        return false;
    }

    async findPlot() {
        const bot = this.bot;
        const ids = ['dirt','grass_block','farmland'].map(name=>bot.registry.blocksByName[name]?.id).filter(id=>id != null);
        const positions = bot.findBlocks({matching:ids,maxDistance:24,count:128});
        positions.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position));
        // Preferer l'eau, mais une terre seche avec un plant reste un recours.
        for (const requireWater of [true,false]) for (const position of positions.slice(0,64)) {
            const crop = bot.blockAt(position.offset(0,1,0));
            if (crop?.name !== 'air' || !this.illuminated(crop) || requireWater && !this.irrigated(position) || !this.safe(position) ||
                this.state().plots.some(p=>new Vec3(p.x,p.y,p.z).equals(position)) ||
                bot.entity.position.floored().equals(position.offset(0,1,0))) continue;
            if (!await this.approach(position)) continue;
            return position;
        }
        return null;
    }

    async tend(position) {
        const bot = this.bot;
        let soil = bot.blockAt(position);
        let crop = bot.blockAt(position.offset(0,1,0));
        if (!soil || !crop || !this.safe(position)) return false;
        if (crop.name === 'wheat' && Number(crop.getProperties().age) === 7) {
            if (!await this.approach(crop.position) || !bot.canDigBlock(crop)) return false;
            this.announce('harvest','Ble mur : je recolte, puis je replante.');
            await withTimeout(bot,bot.dig(crop),4000,'Recolte de ble');
            await bot.waitForTicks(4);
            await this.approach(crop.position,true);
            await bot.waitForTicks(4);
            return true;
        }
        if (crop.name === 'wheat') {
            if (!this.illuminated(crop) || !await this.approach(crop.position)) return false;
            if (!this.count('bone_meal') && this.count('bone')) {
                await new CraftTask(bot,'bone_meal',3).run();
                return true;
            }
            const meal = this.item('bone_meal');
            if (meal) {
                this.announce('grow','J utilise de la poudre d os pour accelerer la pousse du ble.');
                await bot.equip(meal,'hand');
                await withTimeout(bot,bot.activateBlock(crop),3000,'Poudre d os');
                await bot.waitForTicks(3);
                return true;
            }
            return false;
        }
        if (crop.name !== 'air' || !this.count('wheat_seeds') || !this.illuminated(crop)) return false;
        if (!await this.approach(position)) return false;
        if (soil.name !== 'farmland') {
            if (!['dirt','grass_block'].includes(soil.name)) return false;
            const hoe = bot.inventory.items().find(i=>i.name.endsWith('_hoe'));
            if (!hoe) return false;
            await bot.equip(hoe,'hand');
            await withTimeout(bot,bot.activateBlock(soil),3000,'Labour');
            await bot.waitForTicks(3);
            soil = bot.blockAt(position);
            if (soil?.name !== 'farmland') return false;
        }
        this.announce('plant',this.irrigated(position) ? 'Je seme du ble sur une terre irriguee et eclairee.' :
            'Je seme du ble sur une terre eclairee ; aucun terrain irrigue accessible trouve.');
        await bot.equip(this.item('wheat_seeds'),'hand');
        await withTimeout(bot,bot.placeBlock(soil,new Vec3(0,1,0)),3000,'Semis');
        await bot.waitForTicks(3);
        return bot.blockAt(position.offset(0,1,0))?.name === 'wheat';
    }

    async run() {
        this.noteMissing();
        const state = this.state(), bot = this.bot;
        if (this.now()-state.missingSince < this.delay || this.now() < (this.retryAt || 0) || bot.isInCombat?.()) return false;
        try {
            const retained = state.plots.filter(saved => {
                const soil = bot.blockAt(new Vec3(saved.x,saved.y,saved.z));
                return !soil || ['farmland','dirt','grass_block'].includes(soil.name);
            });
            if (retained.length !== state.plots.length) { state.plots = retained; this.save(); }
            if (this.count('wheat') >= 3) {
                if (await this.prepareToolOrTable(false)) return true;
                this.announce('bread','Je fabrique du pain avec le ble recolte.');
                await new CraftTask(bot,'bread',1).run();
                return true;
            }
            // Verifier les champs connus avant de semer ailleurs ; jamais arracher un plant immature.
            if (this.now()-state.checkedAt >= 10000) {
                state.checkedAt = this.now();
                for (const saved of state.plots) {
                    const position = new Vec3(saved.x,saved.y,saved.z);
                    if (position.distanceTo(bot.entity.position) <= 40 && await this.tend(position)) { state.checkedAt = 0; return true; }
                }
            }
            const growing = state.plots.some(p=>bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.name === 'wheat');
            if (!this.count('wheat_seeds') && (state.plots.length < 3 || !growing)) return await this.collectSeeds();
            if (this.count('wheat_seeds') && state.plots.length < 6) {
                if (await this.prepareToolOrTable(true)) return true;
                const position = await this.findPlot();
                if (position && await this.tend(position)) {
                    state.plots.push({x:position.x,y:position.y,z:position.z}); this.save();
                    return true;
                }
            }
            if (state.plots.length) this.announce('waiting','Le ble pousse : je continue a chercher de la nourriture et je reverifierai le champ.');
            return false;
        } catch (error) {
            if (error.code === 'ACTION_INTERRUPTED') throw error;
            this.retryAt = this.now()+15000;
            console.log(`[WheatFarm] Culture differee : ${error.message}`);
            return false;
        }
    }
}

module.exports = WheatFarm;
