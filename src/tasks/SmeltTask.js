const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

class SmeltTask extends Task {
    constructor(bot, inputItem, outputItem, count = 1) {
        super(bot);
        this.name = `Smelt_${inputItem}_to_${outputItem}`;
        this.inputItem = inputItem;
        this.outputItem = outputItem;
        this.count = count;
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        const outputCount = this.bot.inventory.items()
            .filter(i => i.name === this.outputItem)
            .reduce((a, b) => a + b.count, 0);

        if (outputCount >= this.count) {
            this.complete();
            return;
        }

        // Find or place furnace
        let furnace = this.bot.findBlock({
            matching: this.mcData.blocksByName.furnace.id,
            maxDistance: 32
        });

        if (!furnace) {
            // Check if we have a furnace in inventory
            const furnaceItem = this.bot.inventory.items().find(i => i.name === 'furnace');
            if (furnaceItem) {
                await this.placeFurnace(furnaceItem);
                furnace = this.bot.findBlock({
                    matching: this.mcData.blocksByName.furnace.id,
                    maxDistance: 10
                });
            } else {
                console.log(`[${this.name}] No furnace available, need to craft one`);
                this.fail("No furnace");
                return;
            }
        }

        if (!furnace) {
            this.fail("Could not place furnace");
            return;
        }

        // Move close to furnace
        if (this.bot.entity.position.distanceTo(furnace.position) > 3) {
            await this.bot.pathfinder.goto(new goals.GoalNear(
                furnace.position.x, furnace.position.y, furnace.position.z, 2
            ));
        }

        // Open furnace
        console.log(`[${this.name}] Opening furnace at ${furnace.position}`);
        const furnaceBlock = await this.bot.openFurnace(furnace);

        // Add input items (avant le combustible, pour savoir combien il en faut)
        const input = this.bot.inventory.items().find(i => i.name === this.inputItem);
        let addedInput = false;
        let collectedAny = false;
        let needsFuel = false;
        if (input) {
            const alreadyIn = furnaceBlock.inputItem() ? furnaceBlock.inputItem().count : 0;
            const amountToSmelt = Math.min(input.count, this.count - outputCount - alreadyIn);
            if (amountToSmelt > 0) {
                console.log(`[${this.name}] Adding input: ${input.name} x${amountToSmelt}`);
                try {
                    await furnaceBlock.putInput(input.type, null, amountToSmelt);
                    addedInput = true;
                } catch (err) {
                    console.log(`[${this.name}] Failed to put input: ${err.message}`);
                }
            }
        }

        // Combustible : dimensionné sur ce qui reste à fondre dans le four
        if (!(await this.ensureFuel(furnaceBlock))) needsFuel = true;

        // Monitor smelting
        console.log(`[${this.name}] Monitoring smelting...`);
        const maxTicks = 200; // 10 seconds per cycle
        let ticks = 0;

        while (ticks < maxTicks && !needsFuel) {
            await this.bot.waitForTicks(20);
            ticks += 20;
            if (this.cancelled) break;

            // Le combustible s'est épuisé alors qu'il reste du minerai : recharger
            if (!(await this.ensureFuel(furnaceBlock))) {
                needsFuel = true;
                break;
            }

            if (furnaceBlock.outputItem()) {
                console.log(`[${this.name}] Taking output: ${furnaceBlock.outputItem().name}`);
                await furnaceBlock.takeOutput();
                collectedAny = true;
            }

            // Check if we need to return
            const currentOutput = this.bot.inventory.items()
                .filter(i => i.name === this.outputItem)
                .reduce((a, b) => a + b.count, 0);

            if (currentOutput >= this.count) {
                console.log(`[${this.name}] Target reached.`);
                break;
            }

            if (!furnaceBlock.inputItem() && !furnaceBlock.outputItem()) {
                console.log(`[${this.name}] Furnace empty.`);
                break;
            }
        }

        // Récupérer ce qui a fini de fondre avant de fermer
        if (furnaceBlock.outputItem()) {
            try { await furnaceBlock.takeOutput(); collectedAny = true; } catch (_) { }
        }
        const inputLeft = furnaceBlock.inputItem() ? furnaceBlock.inputItem().count : 0;
        furnaceBlock.close();
        if (this.cancelled) return;

        const finalOut = this.bot.inventory.items()
            .filter(i => i.name === this.outputItem)
            .reduce((a, b) => a + b.count, 0);
        if (finalOut >= this.count) return; // complete() au prochain run()

        // Minerai encore dans le four mais plus rien à brûler : échec explicite
        // (needsFuel) pour que l'Agent aille chercher du combustible puis revienne.
        if (needsFuel) {
            this.needsFuel = true;
            this.fail(`Combustible insuffisant (${inputLeft} ${this.inputItem} restant dans le four)`);
            return;
        }

        // Rien ajoute ni collecte et toujours pas assez : le four est vide et on n'a pas
        // de matiere premiere -> echec EXPLICITE pour que l'Agent aille miner, au lieu de
        // relancer Smelt a vide indefiniment.
        if (!addedInput && !collectedAny && inputLeft === 0) {
            this.fail("Rien a fondre (four vide, pas de matiere premiere)");
        }
    }

    // Valeur de combustion en nombre d'objets fondus. Les outils ne sont JAMAIS
    // brûlés : l'ancienne version brûlait la pioche en bois, qui sert de pioche de
    // secours (ensurePickaxeRedundancy), d'où une boucle brûler/re-crafter.
    fuelValue(name) {
        if (name === 'coal_block') return 80;
        if (name === 'coal' || name === 'charcoal') return 8;
        if (name.includes('planks')) return 1.5;
        if (name.includes('log') || name.endsWith('_wood')) return 1.5;
        if (name === 'stick') return 0.5;
        return 0;
    }

    pickFuel() {
        const items = this.bot.inventory.items();
        // Planches avant bûches : 1 bûche = 4 planches = 6 fontes au lieu de 1,5
        const order = [
            i => i.name === 'coal' || i.name === 'charcoal',
            i => i.name === 'coal_block',
            i => i.name.includes('planks'),
            i => i.name.includes('log') || i.name.endsWith('_wood'),
            i => i.name === 'stick',
        ];
        for (const match of order) {
            const fuel = items.find(match);
            if (fuel) return fuel;
        }
        return null;
    }

    // S'assure qu'il y a de quoi brûler pour tout le minerai présent dans le four.
    // Retourne false seulement s'il reste du minerai, que le four est éteint et
    // qu'on n'a plus aucun combustible.
    async ensureFuel(furnaceBlock) {
        const pending = furnaceBlock.inputItem() ? furnaceBlock.inputItem().count : 0;
        if (pending === 0) return true;
        if (furnaceBlock.fuelItem()) return true;           // combustible en attente
        if ((furnaceBlock.fuel || 0) > 0) return true;      // brûle encore

        const fuel = this.pickFuel();
        if (!fuel) {
            console.log(`[${this.name}] Plus de combustible (${pending} ${this.inputItem} en attente).`);
            return false;
        }
        const qty = Math.min(fuel.count, Math.max(1, Math.ceil(pending / this.fuelValue(fuel.name))));
        console.log(`[${this.name}] Adding fuel: ${fuel.name} x${qty} (pour ${pending} à fondre)`);
        try {
            await furnaceBlock.putFuel(fuel.type, null, qty);
            return true;
        } catch (err) {
            console.log(`[${this.name}] Failed to put fuel: ${err.message}`);
            return false;
        }
    }

    async placeFurnace(furnaceItem) {
        const { Vec3 } = require('vec3');
        console.log(`[SmeltTask] Looking for spot to place furnace...`);

        // Blocs occupes par le bot lui-meme : on ne peut pas poser le fourneau dedans.
        const feetPos = this.bot.entity.position.floored();
        const headPos = feetPos.offset(0, 1, 0);

        const nearby = this.bot.findBlocks({
            matching: b => b.type !== this.mcData.blocksByName.air.id &&
                b.boundingBox === 'block' &&
                b.name !== 'crafting_table' && // Avoid placing on crafting table
                b.name !== 'furnace',
            maxDistance: 4,
            count: 30
        });

        // Poser au plus proche d'abord (utile quand le bot est perche sur un pilier)
        nearby.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));

        for (const pos of nearby) {
            const above = pos.offset(0, 1, 0);
            const blockAbove = this.bot.blockAt(above);

            // L'espace au-dessus doit etre vide (air ou plante remplacable)...
            if (!blockAbove || !(blockAbove.name.includes('air') || blockAbove.name.includes('grass') ||
                blockAbove.name.includes('fern') || blockAbove.name.includes('snow'))) continue;

            // ...et ne pas etre la colonne ou se tient le bot (sinon placement impossible).
            // Ancien bug : un test de distance > 2.0 rejetait TOUS les blocs adjacents
            // quand le bot etait perche sur un pilier d'1 bloc -> aucune pose possible.
            if (above.equals(feetPos) || above.equals(headPos)) continue;

            try {
                console.log(`[SmeltTask] Attempting to place furnace at ${above}`);
                await this.bot.equip(furnaceItem, 'hand');
                await this.bot.lookAt(pos.offset(0.5, 1, 0.5), false);
                await this.bot.placeBlock(this.bot.blockAt(pos), new Vec3(0, 1, 0));
                console.log(`[SmeltTask] Furnace placed successfully.`);
                return;
            } catch (err) {
                console.log(`[SmeltTask] Failed to place furnace at ${above}: ${err.message}`);
                // Continue to next spot
            }
        }
        
        // If still failed, just try to place it right at our feet (minus 1)
        console.log(`[SmeltTask] Strict placement failed, trying fallback placement...`);
        const fallbackPos = this.bot.entity.position.floored().offset(1, 0, 0);
        try {
            await this.bot.equip(furnaceItem, 'hand');
            await this.bot.placeBlock(this.bot.blockAt(fallbackPos.offset(0, -1, 0)), new Vec3(0, 1, 0));
            console.log(`[SmeltTask] Fallback furnace placed.`);
            return;
        } catch(e) {}

        throw new Error("Could not find a valid spot to place furnace");
    }
}

module.exports = SmeltTask;
