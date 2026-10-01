const { Vec3 } = require('vec3');
const { threatNearPoint } = require('./MobSafety');

class TorchLighting {
    constructor(bot) { this.bot = bot; this.nextCheck = 0; this.lastMessage = 0; }

    async tick() {
        const bot = this.bot;
        if (Date.now() < this.nextCheck || bot.isInCombat?.() || bot.targetDigBlock) return;
        this.nextCheck = Date.now() + 2000;
        const feet = bot.entity.position.floored();
        const light = bot.blockAt(feet);
        if (!light || Math.max(light.light ?? 0, light.skyLight ?? 0) >= 7) return;
        if (/water|lava/.test(light.name) || threatNearPoint(bot, feet, 3)) return;
        const items = bot.inventory.items();
        let torch = items.find(i => i.name === 'torch');
        if (!torch) {
            const fuel = items.find(i => i.name === 'coal' || i.name === 'charcoal');
            const stick = items.find(i => i.name === 'stick');
            if (fuel && stick) {
                const recipes = bot.recipesFor(bot.registry.itemsByName.torch.id, null, 1, null);
                if (recipes.length) { await bot.craft(recipes[0], 1, null); torch = bot.inventory.items().find(i => i.name === 'torch'); }
            }
        }
        if (!torch) {
            if (Date.now() - this.lastMessage > 60000) {
                this.lastMessage = Date.now();
                bot.chat('[SpeedBot] Zone sombre : il me manque des torches ou du charbon et des batons.');
            }
            return;
        }
        const held = bot.heldItem;
        for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const target = feet.offset(dx,0,dz);
            const floor = bot.blockAt(target.offset(0,-1,0));
            if (bot.blockAt(target)?.name !== 'air' || floor?.boundingBox !== 'block' || /magma|lava/.test(floor.name)) continue;
            try {
                await bot.equip(torch, 'hand');
                await bot.placeBlock(floor, new Vec3(0,1,0));
                bot.chat('[SpeedBot] Lumiere inferieure a 7 : torche posee.');
                return;
            } catch (error) { console.log(`[TorchLighting] ${error.message}`); }
            finally { if (held && bot.inventory.items().some(i => i === held) && !bot.isInCombat?.()) await bot.equip(held,'hand'); }
        }
    }
}

module.exports = TorchLighting;
