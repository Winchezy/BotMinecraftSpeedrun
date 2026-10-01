const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { withTimeout } = require('../lib/Pathing');

// Remplit un seau vide a une source d'eau (necessaire pour fabriquer l'obsidienne).
class FillBucket extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'FillBucket';
        this.blacklist = new Set();
        this.wanders = 0;
    }

    async run() {
        const items = this.bot.inventory.items();
        if (items.some(i => i.name === 'water_bucket')) { this.complete(); return; }
        const bucket = items.find(i => i.name === 'bucket');
        if (!bucket) { this.fail('Pas de seau'); return; }

        const source = this.findWaterSource();
        if (!source) {
            if (this.wanders >= 3) { this.fail("Pas d'eau"); return; }
            this.wanders++;
            await this.wander();
            return;
        }

        const key = source.position.toString();
        try {
            await withTimeout(this.bot, this.bot.pathfinder.goto(
                new goals.GoalNear(source.position.x, source.position.y, source.position.z, 3)), 30000);
            await this.bot.equip(bucket, 'hand');
            await this.bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
            await this.bot.waitForTicks(2); // lookAt(force) n'envoie la rotation qu'au tick suivant
            this.bot.activateItem();
            await this.bot.waitForTicks(6);
        } catch (e) {
            console.log(`[FillBucket] Echec vers ${key}: ${e.message}`);
        }
        if (this.bot.inventory.items().some(i => i.name === 'water_bucket')) {
            console.log('[FillBucket] Seau d\'eau rempli.');
            this.complete();
        } else {
            this.blacklist.add(key);
        }
    }

    // Source d'eau (niveau 0) accessible depuis un sol sec voisin.
    findWaterSource() {
        const water = this.bot.registry.blocksByName.water.id;
        const positions = this.bot.findBlocks({ matching: water, maxDistance: 64, count: 200 });
        for (const pos of positions) {
            if (this.blacklist.has(pos.toString())) continue;
            const block = this.bot.blockAt(pos);
            if (!block || block.metadata !== 0) continue;
            const above = this.bot.blockAt(pos.offset(0, 1, 0));
            if (!above || above.name !== 'air') continue; // surface de l'eau, visible
            const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
                const floor = this.bot.blockAt(pos.offset(dx, 0, dz));
                const feet = this.bot.blockAt(pos.offset(dx, 1, dz));
                return floor?.boundingBox === 'block' && feet?.name === 'air';
            });
            if (shore) return block;
        }
        return null;
    }

    async wander() {
        const p = this.bot.entity.position;
        const angle = Math.random() * Math.PI * 2;
        const target = new Vec3(p.x + Math.cos(angle) * 60, p.y, p.z + Math.sin(angle) * 60);
        console.log(`[FillBucket] Pas d'eau a portee, exploration vers ${target.floored()}.`);
        try {
            await withTimeout(this.bot, this.bot.pathfinder.goto(new goals.GoalNearXZ(target.x, target.z, 5)), 30000);
        } catch (_) { }
    }

}

module.exports = FillBucket;
