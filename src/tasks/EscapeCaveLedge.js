const Task = require('../lib/Task');
const { Movements, goals } = require('mineflayer-pathfinder');
const { disableDiagonalMoves } = require('../lib/Pathing');
const { isHostileMob } = require('../lib/MobThreats');

const BREAKABLE = new Set([
    'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff',
    'coal_ore', 'deepslate_coal_ore', 'dirt', 'cobblestone'
]);

class EscapeCaveLedge extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'EscapeCaveLedge';
        this.mcData = require('minecraft-data')(bot.version);
    }

    safeBlock(block) {
        return block && block.boundingBox === 'block' &&
            !/lava|magma|cactus|fire/.test(block.name);
    }

    hostileNear(position, radius) {
        return Object.values(this.bot.entities || {}).some(entity =>
            isHostileMob(entity) && entity.position?.distanceTo(position) < radius);
    }

    makeMovements() {
        const movements = new Movements(this.bot, this.mcData);
        movements.maxDropDown = 0;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        movements.allowFreeMotion = false;
        movements.canSwim = false;
        movements.canDig = true;
        movements.scafoldingBlocks = ['cobblestone', 'dirt', 'andesite']
            .map(name => this.mcData.itemsByName[name]?.id).filter(id => id != null);
        for (const name of ['water', 'lava']) {
            const id = this.mcData.blocksByName[name]?.id;
            if (id != null) {
                movements.blocksToAvoid.add(id);
                movements.blocksCantBreak.add(id);
            }
        }
        movements.safeToBreak = block => BREAKABLE.has(block.name) &&
            block.position.y >= Math.floor(this.bot.entity.position.y);
        return disableDiagonalMoves(movements);
    }

    findRoute(movements) {
        const start = this.bot.entity.position.floored();
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const candidates = [];
        for (let distance = 2; distance <= 5; distance++) {
            for (const [dx, dz] of dirs) {
                const target = start.offset(dx * distance, 0, dz * distance);
                const floor = this.bot.blockAt(target.offset(0, -1, 0));
                const foundation = this.bot.blockAt(target.offset(0, -2, 0));
                const feet = this.bot.blockAt(target);
                const head = this.bot.blockAt(target.offset(0, 1, 0));
                if (!this.safeBlock(floor) || !this.safeBlock(foundation) || !feet || !head) continue;
                if (![feet, head].every(b => !/water|lava|fire/.test(b.name) &&
                    (b.boundingBox === 'empty' || BREAKABLE.has(b.name)))) continue;
                if (this.hostileNear(target, 8)) continue;
                const goal = new goals.GoalBlock(target.x, target.y, target.z);
                const result = this.bot.pathfinder.getPathTo(movements, goal, 800);
                if (result.status !== 'success' || !result.path.length) continue;
                const route = result.path;
                if (route.length > 8 || route.some(step => step.y < start.y || step.parkour ||
                    Math.abs(step.x - start.x) > 6 || Math.abs(step.z - start.z) > 6 ||
                    step.toBreak.some(b => b.y < start.y))) continue;
                candidates.push({ goal, target, cost: route.at(-1).cost });
            }
        }
        candidates.sort((a, b) => a.cost - b.cost);
        return candidates[0] || null;
    }

    async run() {
        if (this.bot.health < 10 || this.bot.isInCombat?.() ||
            this.hostileNear(this.bot.entity.position, 10)) {
            this.fail('Sortie dangereuse: sante ou mob hostile');
            return;
        }
        const previous = this.bot.pathfinder.movements;
        const movements = this.makeMovements();
        const route = this.findRoute(movements);
        if (!route) { this.fail('Aucun trajet stable hors de la grotte'); return; }
        console.log(`[EscapeCaveLedge] Sortie prevue vers ${route.target}.`);
        let timer;
        try {
            this.bot.pathfinder.setMovements(movements);
            await Promise.race([
                this.bot.pathfinder.goto(route.goal),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Sortie trop longue')), 20000);
                })
            ]);
            if (this.bot.entity.position.distanceTo(route.target.offset(0.5, 0, 0.5)) > 1.5) {
                this.fail('Destination non atteinte');
            } else {
                this.complete();
            }
        } catch (error) {
            this.fail(error.message);
        } finally {
            clearTimeout(timer);
            try { this.bot.pathfinder.stop(); } catch (_) { }
            this.bot.pathfinder.setMovements(previous);
        }
    }
}

module.exports = EscapeCaveLedge;
