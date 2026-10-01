const DeathRecovery = require('./DeathRecovery');
const MushroomFood = require('./MushroomFood');
const { goals } = require('mineflayer-pathfinder');
const { existingPassageMovements, planCompletePath } = require('./Pathing');
const { threatNearPath, threatNearPoint } = require('./MobSafety');

// Partage les passages prudents dans le feuillage sans creer de recuperation
// de mort ni lire/ecrire sa position persistante.
class TreeEscape extends DeathRecovery {
    constructor(bot) { super(bot, { persist: false }); }

    checkActive() {
        const lease = this.bot.actions?.context.getStore();
        if (lease && !this.bot.actions.valid(lease)) {
            const error = new Error('Descente interrompue');
            error.code = 'ACTION_INTERRUPTED';
            throw error;
        }
        if (this.bot.isInCombat?.()) throw new Error('Combat pendant la descente');
    }

    onTree() {
        const floor = this.bot.blockAt(this.bot.entity.position.floored().offset(0, -1, 0));
        if (floor?.name.endsWith('_planks') && floor.position &&
            this.bot.blockAt(floor.position.offset(0, -1, 0))?.name === 'air' &&
            [[1,0],[-1,0],[0,1],[0,-1]].filter(([x,z]) =>
                this.bot.blockAt(floor.position.offset(x,0,z))?.boundingBox === 'empty').length >= 3) {
            this.bot.descentSupportKey = floor.position.toString();
        }
        return /_(leaves|log)$/.test(floor?.name || '') ||
            !!floor?.position && floor.position.toString() === this.bot.descentSupportKey;
    }

    async run() {
        const bot = this.bot;
        if (!this.onTree() || !bot.canDigBlock || bot.isInCombat?.()) return false;
        const origin = bot.entity.position.clone();
        if (await new MushroomFood(bot, null).lowerPillar(origin.offset(0, -4, 0))) return true;
        // Viser le tronc proche plutot qu'une autre cime.
        const trunk = bot.findBlock?.({ matching: b => b.name.endsWith('_log'), maxDistance: 8 });
        const towards = trunk?.position || origin.offset(0, -8, 0);
        if (await this.openTreeExit(towards, 0)) return true;
        const floors = bot.findBlocks({ matching: b => b.boundingBox === 'block', maxDistance: 8, count: 128,
            useExtraInfo: b => !!b?.position && b.position.y + 1 < origin.y &&
                this.standable(b.position.x, b.position.y + 1, b.position.z) });
        const walking = existingPassageMovements(bot);
        walking.maxDropDown = 1;
        walking.allowParkour = false;
        floors.sort((a, b) => a.y - b.y || a.distanceTo(origin) - b.distanceTo(origin));
        for (const floor of floors.slice(0, 12)) {
            this.checkActive();
            const point = floor.offset(0, 1, 0);
            if (threatNearPoint(bot, point, 3)) continue;
            const route = await planCompletePath(bot, new goals.GoalBlock(point.x, point.y, point.z), 400, walking);
            if (route.status !== 'success' || threatNearPath(bot, route.path)) continue;
            bot.pathfinder.setMovements(walking);
            await this.moveTo(point, 0, Date.now() + 10000);
            return bot.entity.position.y < origin.y;
        }
        return this.stepOffLeaf(towards);
    }
}

module.exports = TreeEscape;
