const { goals } = require('mineflayer-pathfinder');
const { existingPassageMovements, planCompletePath, withTimeout } = require('./Pathing');
const { threatNearPath, threatNearPoint } = require('./MobSafety');

class WaterEscape {
    constructor(bot) { this.bot = bot; this.busy = false; this.active = false; this.nextSearch = 0; this.visits = new Map(); this.failedExits = new Map(); }

    dryFloors() {
        const bot = this.bot;
        return bot.findBlocks({
            matching: block => block.boundingBox === 'block' && !/lava|magma|fire/.test(block.name),
            useExtraInfo: block => !!block?.position &&
                bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air' &&
                bot.blockAt(block.position.offset(0, 2, 0))?.boundingBox === 'empty',
            maxDistance: 32, count: 32
        });
    }

    async tick(inWater) {
        const actions = this.bot.actions;
        if (!actions) return this.performTick(inWater);
        if (inWater) return actions.run('water', 100, () => this.performTick(true), { persistent: true });
        if (actions.current?.owner === 'water') {
            return actions.run('water', 100, async () => {
                await this.performTick(false);
                actions.cancel('Sortie de l eau terminee');
            }, { persistent: true });
        }
        this.active = false;
    }

    async performTick(inWater) {
        const bot = this.bot;
        if (!inWater) {
            if (this.active) {
                bot.clearControlStates();
                this.active = false;
                this.visits.clear();
                console.log('[WaterEscape] Sol sec atteint.');
            }
            return;
        }
        if (this.busy) return;
        this.busy = true;
        try {
            if (!this.active) {
                this.active = true;
                bot.pathfinder.stop();
                bot.clearControlStates();
                bot.chat('[SpeedBot] Dans l eau : recherche d une sortie accessible.');
            }
            bot.setControlState('jump', true);
            if (Date.now() < this.nextSearch) return;
            this.nextSearch = Date.now() + 3000;
            const original = bot.pathfinder.movements;
            const swimming = existingPassageMovements(bot);
            const water = bot.registry.blocksByName.water.id;
            swimming.blocksToAvoid = new Set(original.blocksToAvoid);
            swimming.blocksToAvoid.delete(water);
            swimming.liquidCost = 1;
            for (const floor of this.dryFloors()) {
                const point = floor.offset(0, 1, 0);
                if ((this.failedExits.get(point.toString()) || 0) > Date.now()) continue;
                if (threatNearPoint(bot, point, 3)) continue;
                const goal = new goals.GoalBlock(point.x, point.y, point.z);
                const route = await planCompletePath(bot, goal, 500, swimming);
                if (route.status !== 'success' || threatNearPath(bot, route.path)) continue;
                console.log(`[WaterEscape] Sortie vers ${point}.`);
                bot.pathfinder.setMovements(swimming);
                const timeBudget = Math.min(4000, Math.max(1000, (bot.oxygenLevel ?? 20) * 200));
                try { await withTimeout(bot, bot.pathfinder.goto(goal), timeBudget, 'Sortie de l eau bloquee'); }
                catch (error) {
                    if (this.failedExits.size > 64) this.failedExits.clear();
                    this.failedExits.set(point.toString(), Date.now() + 30000);
                    console.log(`[WaterEscape] ${error.message}, autre sortie requise.`);
                }
                finally { if (bot.pathfinder.movements === swimming) bot.pathfinder.setMovements(original); }
                return;
            }
            // Pas de trajet complet : explorer un espace adjacent libre, au lieu
            // de pousser indefiniment contre un plafond plein.
            const origin = bot.entity.position.floored();
            const candidates = [[1,0],[-1,0],[0,1],[0,-1]].map(([x,z]) => origin.offset(x,0,z))
                .filter(p => [bot.blockAt(p), bot.blockAt(p.offset(0,1,0))].every(b =>
                    b && (b.name === 'water' || b.boundingBox === 'empty') && !/lava|fire/.test(b.name)) &&
                    !threatNearPoint(bot,p,2));
            candidates.sort((a,b) => (this.visits.get(a.toString()) || 0) - (this.visits.get(b.toString()) || 0));
            const next = candidates[0];
            if (next) {
                if (this.visits.size > 128) this.visits.clear();
                this.visits.set(next.toString(), (this.visits.get(next.toString()) || 0) + 1);
                await bot.lookAt(next.offset(0.5,1,0.5));
                bot.setControlState('forward', true);
                try { await bot.waitForTicks(16); }
                finally { bot.setControlState('forward', false); }
            }
        } finally { this.busy = false; }
    }
}

module.exports = WaterEscape;
