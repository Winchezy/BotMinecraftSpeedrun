const { goals } = require('mineflayer-pathfinder');
const CraftTask = require('../tasks/CraftTask');
const GetWood = require('../tasks/GetWood');
const { existingPassageMovements, planCompletePath, withTimeout } = require('./Pathing');
const { threatNearPoint, threatNearPath } = require('./MobSafety');

class MushroomFood {
    constructor(bot, memory) { this.bot = bot; this.memory = memory; this.preparation = null; this.registry = bot.registry || require('minecraft-data')(bot.version); }

    async lowerPillar(target) {
        const bot = this.bot;
        const feet = bot.entity.position.floored();
        if (target.y >= feet.y - 2 || Math.hypot(target.x-feet.x,target.z-feet.z) > 6 || bot.isInCombat?.()) return false;
        const floor = bot.blockAt(feet.offset(0,-1,0));
        let landing = bot.blockAt(feet.offset(0,-2,0));
        const pillarBlocks = ['cobblestone','cobbled_deepslate','diorite','andesite','granite','dirt','coarse_dirt'];
        const ownSupport = !!bot.descentSupportKey && floor?.position?.toString() === bot.descentSupportKey;
        const leaves = floor?.name.endsWith('_leaves');
        const trunk = floor?.name.endsWith('_log');
        if (!floor || !landing || (!pillarBlocks.includes(floor.name) && !leaves && !trunk && !ownSupport) ||
            /lava|magma|fire/.test(landing.name) || threatNearPoint(bot, feet.offset(0,-1,0),3)) return false;
        let openSides = 0;
        for (const [x,y,z] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
            const neighbor = bot.blockAt(floor.position.offset(x,y,z));
            if (!neighbor || /water|lava|sand|gravel/.test(neighbor.name)) return false;
            if (neighbor.boundingBox === 'empty') openSides++;
        }
        if (!leaves && !trunk && openSides < 3) return false;
        if (landing.boundingBox !== 'block') {
            // Creer un support avant de retirer le bloc porteur : jamais de
            // descente dans le vide, meme si la pose echoue.
            const support=bot.inventory?.items?.().find(i=>/^(cobblestone|dirt)$|_(planks|log)$/.test(i.name));
            if (!support || landing.name!=='air' || !bot.placeBlock) return false;
            for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const neighbor=bot.blockAt(landing.position.offset(x,0,z));
                if (!neighbor || /water|lava|sand|gravel/.test(neighbor.name)) return false;
            }
            bot.pathfinder.setGoal?.(null);bot.clearControlStates();
            try {
                await bot.equip(support,'hand');
                await withTimeout(bot,bot.placeBlock(floor,new (require('vec3').Vec3)(0,-1,0)),5000,'Pose du support bloquee');
                landing=bot.blockAt(feet.offset(0,-2,0));
                if (landing?.boundingBox!=='block') return false;
                bot.descentSupportKey = landing.position.toString();
                console.log('[MushroomFood] Support de descente pose et verifie.');
            } catch(error) {console.log(`[MushroomFood] Support refuse : ${error.message}`);return false;}
        }
        if (!bot.canDigBlock(floor)) return false;
        const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
        if (!pick && /stone|diorite|andesite|granite/.test(floor.name)) return false;
        bot.pathfinder.stop();
        bot.clearControlStates();
        if (pick) await bot.equip(pick,'hand');
        bot.isDismantlingPillar = true;
        try {
            await withTimeout(bot, bot.dig(floor), 6000, 'Descente de la pile bloquee');
            await bot.waitForTicks(8);
            bot.lastFoodPillarDescent = Date.now();
            console.log('[MushroomFood] Descente controlee de la pile, une marche.');
            return true;
        } finally { bot.isDismantlingPillar = false; }
    }

    async run() {
        const bot = this.bot;
        if (bot.isInCombat?.()) return false;
        if (this.preparation) {
            await this.preparation.run();
            if (!this.preparation.isDone()) return true;
            const failed = this.preparation.hasFailed;
            this.preparation = null;
            if (failed) return false;
        }
        const items = bot.inventory.items();
        const has = name => items.some(i => i.name === name);
        if (has('brown_mushroom') && has('red_mushroom')) {
            if (!has('bowl')) {
                const planks = items.filter(i=>i.name.endsWith('_planks')).reduce((n,i)=>n+i.count,0);
                const log = items.find(i=>i.name.endsWith('_log'));
                this.preparation = planks >= 3 ? new CraftTask(bot,'bowl') :
                    log ? new CraftTask(bot,log.name.replace('_log','_planks'),3) : new GetWood(bot,2);
                return true;
            }
            const recipes = bot.recipesFor(this.registry.itemsByName.mushroom_stew.id,null,1,null);
            if (recipes.length) {
                await bot.craft(recipes[0],1,null);
                bot.chat?.('[SpeedBot] Soupe preparee avec champignon brun, rouge et bol.');
                return true;
            }
            return false;
        }
        if (!bot.findBlocks) return false;
        const names = ['brown_mushroom','red_mushroom'].filter(name=>!has(name));
        const positions = bot.findBlocks({ matching: names.map(n=>this.registry.blocksByName[n].id), maxDistance:bot.foodSearchArea?.radius || 64,count:16 });
        if (!positions.length) return false;
        const original = bot.pathfinder.movements;
        const walking = existingPassageMovements(bot);
        for (const point of positions) {
            if (threatNearPoint(bot,point,3) || !this.memory.allowed(bot.entity.position,point,false)) continue;
            const goal = new goals.GoalLookAtBlock(point,bot.world,{reach:3});
            const route = await planCompletePath(bot,goal,800,walking);
            if (route.status !== 'success' || threatNearPath(bot,route.path)) {
                if (await this.lowerPillar(point)) return true;
                this.memory.markBlocked(bot.entity.position,point,route.status);
                continue;
            }
            bot.pathfinder.setMovements(walking);
            try {
                await withTimeout(bot,bot.pathfinder.goto(goal),10000,'Champignon inaccessible');
                const mushroom = bot.blockAt(point);
                if (!mushroom || !names.includes(mushroom.name)) continue;
                await bot.dig(mushroom);
                await withTimeout(bot,bot.pathfinder.goto(new goals.GoalNear(point.x,point.y,point.z,1)),5000,'Ramassage de champignon bloque');
                await bot.waitForTicks(5);
                bot.chat?.('[SpeedBot] Champignon recolte pour une soupe.');
                return true;
            } catch(error) { this.memory.markBlocked(bot.entity.position,point,'timeout'); }
            finally { if (bot.pathfinder.movements === walking) bot.pathfinder.setMovements(original); }
        }
        return false;
    }
}

module.exports = MushroomFood;
