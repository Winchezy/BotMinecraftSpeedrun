const CraftTask = require('../tasks/CraftTask');
const GetWood = require('../tasks/GetWood');
const { threatNearPoint } = require('./MobSafety');

class CombatPreparation {
    constructor(bot) { this.bot = bot; this.task = null; this.retryAt = 0; }

    noteBlocked(now = Date.now()) {
        const bot = this.bot;
        if (!bot.mobBlockedSince || now - (bot.lastMobBlock || 0) > 60000) bot.mobBlockedSince = now;
        bot.lastMobBlock = now;
        if (now - bot.mobBlockedSince >= 30000) bot.weaponNeeded = true;
    }

    async run() {
        const bot = this.bot;
        const items = bot.inventory.items();
        if (items.some(i => i.name.endsWith('_sword'))) {
            bot.weaponNeeded = false;
            this.task = null;
            return false;
        }
        if (Date.now() < this.retryAt || bot.isInCombat?.() || threatNearPoint(bot, bot.entity.position)) return false;
        if (this.task && !this.task.isDone()) {
            await this.task.run();
            return true;
        }
        if (this.task?.hasFailed) { this.retryAt = Date.now() + 10000; this.task = null; return false; }
        const count = name => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
        const planks = items.filter(i => i.name.endsWith('_planks')).reduce((n, i) => n + i.count, 0);
        const log = items.find(i => i.name.endsWith('_log'));
        const sword = count('diamond') >= 2 ? 'diamond_sword' : count('iron_ingot') >= 2 ? 'iron_sword' :
            count('cobblestone') >= 2 ? 'stone_sword' : 'wooden_sword';
        if ((planks < 2 && count('stick') < 1) || (sword === 'wooden_sword' && planks < 2)) {
            this.task = log ? new CraftTask(bot, log.name.replace('_log', '_planks'), 4) : new GetWood(bot, 2);
        } else if (count('stick') < 1) this.task = new CraftTask(bot, 'stick');
        else {
            const table = bot.findBlock({ matching: require('minecraft-data')(bot.version).blocksByName.crafting_table.id,
                maxDistance: 4, useExtraInfo: block => CraftTask.usableTable(bot, block) });
            if (!table && count('crafting_table') < 1) {
                this.task = planks >= 4 ? new CraftTask(bot, 'crafting_table') :
                    log ? new CraftTask(bot, log.name.replace('_log', '_planks'), planks + 4) : new GetWood(bot, 2);
            } else this.task = new CraftTask(bot, sword);
        }
        const message = `[SpeedBot] Les mobs retardent mes objectifs : preparation d'une epee (${this.task.name}).`;
        console.log(`[CombatPreparation] ${message}`);
        bot.chat?.(message);
        return true;
    }
}

module.exports = CombatPreparation;
