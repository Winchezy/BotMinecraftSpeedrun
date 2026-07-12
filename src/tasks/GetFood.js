const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

// Aliments mangeables. On accepte le cru SUR uniquement (boeuf/porc/mouton/lapin/
// poisson ne donnent aucun effet negatif). On EXCLUT le poulet cru (effet Hunger ~30%)
// et la chair putrefiee : pas d'empoisonnement. Le poulet CUIT reste autorise.
const EDIBLE = [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
    'cooked_cod', 'cooked_salmon', 'bread', 'apple', 'golden_apple', 'baked_potato',
    'carrot', 'melon_slice', 'beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon'
];
// Animaux passifs a chasser (pas le poulet : on ne mangerait pas sa viande crue).
const PREY = ['cow', 'pig', 'sheep', 'rabbit', 'mooshroom'];

class GetFood extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'GetFood';
        this.mcData = require('minecraft-data')(bot.version);
    }

    findEdible() {
        return this.bot.inventory.items().find(i => EDIBLE.includes(i.name));
    }

    async run() {
        // 1. On a de quoi manger -> manger jusqu'a (presque) rassasie.
        if (this.findEdible()) {
            try {
                let guard = 0;
                while (this.bot.food < 18 && guard < 8) {
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
        const prey = this.bot.nearestEntity(e =>
            e && e.position && PREY.includes((e.name || '').toLowerCase()) &&
            e.position.distanceTo(this.bot.entity.position) < 32
        );
        if (!prey) {
            console.log("[GetFood] Aucun animal a proximite.");
            this.fail("Pas d'animal proche");
            return;
        }

        console.log(`[GetFood] Chasse: ${prey.name} a ${prey.position.floored()}`);
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

        // Au prochain tick : si de la viande a ete ramassee, l'etape 1 la mangera.
        this.complete();
    }
}

module.exports = GetFood;
