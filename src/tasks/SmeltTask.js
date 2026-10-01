const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { threatNearPoint, threatNearPath } = require('../lib/MobSafety');
const { planCompletePath, withTimeout } = require('../lib/Pathing');
const { getFuelSmeltOutput } = require('../lib/ResourceAmounts');

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
        let furnace = null;
        if (this.bot.isInCombat?.()) return;
        const positions = this.bot.findBlocks({ matching: this.mcData.blocksByName.furnace.id, maxDistance: 32, count: 16 });
        for (const pos of positions) {
            if (threatNearPoint(this.bot, pos, 4)) continue;
            const route = await planCompletePath(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2));
            if (route.status === 'success' && !threatNearPath(this.bot, route.path)) {
                furnace = this.bot.blockAt(pos);
                break;
            }
        }

        if (!furnace) {
            await require('../lib/Workstations')(this.bot).recover('furnace');
            // Check if we have a furnace in inventory
            const furnaceItem = this.bot.inventory.items().find(i => i.name === 'furnace');
            if (furnaceItem) {
                if (threatNearPoint(this.bot, this.bot.entity.position, 4) && !await this.relocateWorkstation()) {
                    this.fail('Mobs sur le trajet du four');
                    return;
                }
                furnace = await this.placeFurnace(furnaceItem);
            } else {
                console.log(`[${this.name}] No furnace available, need to craft one`);
                this.fail(positions.length ? 'Mobs sur le trajet du four' : 'No furnace');
                return;
            }
        }

        if (!furnace) {
            if (!this.hasFailed) this.fail("Could not place furnace");
            return;
        }

        // Move close to furnace
        if (this.bot.entity.position.distanceTo(furnace.position) > 3) {
            await withTimeout(this.bot, this.bot.pathfinder.goto(new goals.GoalNear(
                furnace.position.x, furnace.position.y, furnace.position.z, 2
            )), 15000, 'Trajet du four trop long');
        }

        if (threatNearPoint(this.bot, furnace.position, 4) || this.bot.isInCombat?.()) {
            this.fail('Mobs sur le trajet du four');
            return;
        }

        // Open furnace
        console.log(`[${this.name}] Opening furnace at ${furnace.position}`);
        const furnaceBlock = await this.bot.openFurnace(furnace);
        try {
        // Recuperer le resultat deja disponible meme sans combustible en poche.
        if (furnaceBlock.outputItem()?.name === this.outputItem) {
            await furnaceBlock.takeOutput();
            const ready = this.bot.inventory.items().filter(i => i.name === this.outputItem)
                .reduce((n, i) => n + i.count, 0);
            if (ready >= this.count) { this.complete(); return; }
        }

        // Add fuel if needed
        if (!furnaceBlock.fuelItem()) {
            const items = this.bot.inventory.items();
            let fuel = items.find(i => i.name === 'coal' || i.name === 'charcoal');
            if (!fuel) fuel = items.find(i => i.name.includes('planks'));
            if (!fuel) fuel = items.find(i => i.name.includes('log'));
            if (!fuel) fuel = items.find(i => i.name === 'stick');

            // Emergency fuel: wooden tools if we have better ones
            if (!fuel) {
                const hasStonePick = items.some(i => i.name === 'stone_pickaxe' || i.name === 'iron_pickaxe' || i.name === 'diamond_pickaxe');
                if (hasStonePick) {
                    fuel = items.find(i => i.name === 'wooden_pickaxe');
                }
            }
            // Emergency fuel: wooden sword if we have stone
            if (!fuel) {
                const hasStoneSword = items.some(i => i.name === 'stone_sword' || i.name === 'iron_sword' || i.name === 'diamond_sword');
                if (hasStoneSword) {
                    fuel = items.find(i => i.name === 'wooden_sword');
                }
            }


            if (fuel) {
                console.log(`[${this.name}] Adding fuel: ${fuel.name}`);
                try {
                    const pending = furnaceBlock.inputItem();
                    const carried = items.filter(i => i.name === this.inputItem).reduce((n,i) => n+i.count,0);
                    const remaining = Math.min(this.count - outputCount, carried + (pending?.name === this.inputItem ? pending.count : 0));
                    const capacity = getFuelSmeltOutput(fuel.name);
                    if (remaining > 0 && capacity > 0)
                        await furnaceBlock.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(remaining / capacity)));
                } catch (err) {
                    console.log(`[${this.name}] Failed to put fuel: ${err.message}`);
                }
            } else {
                console.log(`[${this.name}] No fuel available in inventory.`);
                this.fail("No fuel available");
                return;
            }
        }

        // Add input items
        const input = this.bot.inventory.items().find(i => i.name === this.inputItem);
        let addedInput = false;
        let collectedAny = false;
        if (input) {
            const amountToSmelt = Math.min(input.count, this.count - outputCount);
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

        // Monitor smelting
        console.log(`[${this.name}] Monitoring smelting...`);
        const maxTicks = Math.min(1200, Math.max(240, this.count * 240));
        let ticks = 0;

        while (ticks < maxTicks) {
            await this.bot.waitForTicks(20);
            ticks += 20;

            if (threatNearPoint(this.bot, furnace.position, 4) || this.bot.isInCombat?.() ||
                this.bot.entity.position.distanceTo(furnace.position) > 4) {
                this.fail('Mobs sur le trajet du four');
                return;
            }

            if (furnaceBlock.outputItem()?.name === this.outputItem) {
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

        // Rien ajoute ni collecte et toujours pas assez : le four est vide et on n'a pas
        // de matiere premiere -> echec EXPLICITE pour que l'Agent aille miner, au lieu de
        // relancer Smelt a vide indefiniment.
        const finalOut = this.bot.inventory.items()
            .filter(i => i.name === this.outputItem)
            .reduce((a, b) => a + b.count, 0);
        if (finalOut < this.count && !addedInput && !collectedAny) {
            this.fail("Rien a fondre (four vide, pas de matiere premiere)");
        }
        if (finalOut >= this.count) this.complete();
        } finally {
            furnaceBlock.close();
        }
    }

    async placeFurnace(furnaceItem) {
        const { Vec3 } = require('vec3');
        console.log(`[SmeltTask] Looking for spot to place furnace...`);

        // Blocs occupes par le bot lui-meme : on ne peut pas poser le fourneau dedans.
        const feetPos = this.bot.entity.position.floored();
        const headPos = feetPos.offset(0, 1, 0);
        if (threatNearPoint(this.bot, feetPos, 4) || this.bot.isInCombat?.()) {
            this.fail('Mobs sur le trajet du four');
            return null;
        }

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
            if (Math.abs(above.y - feetPos.y) > 1 || threatNearPoint(this.bot, above, 4)) continue;
            // Le bot doit pouvoir rester sur un sol stable pour acceder au four.
            const floor = this.bot.blockAt(feetPos.offset(0, -1, 0));
            if (floor?.boundingBox !== 'block' || /lava|magma|fire/.test(floor.name)) continue;

            // L'espace au-dessus doit etre vide...
            if (!blockAbove || blockAbove.type !== this.mcData.blocksByName.air.id) continue;

            // ...et ne pas etre la colonne ou se tient le bot (sinon placement impossible).
            // Ancien bug : un test de distance > 2.0 rejetait TOUS les blocs adjacents
            // quand le bot etait perche sur un pilier d'1 bloc -> aucune pose possible.
            if (above.equals(feetPos) || above.equals(headPos)) continue;

            try {
                console.log(`[SmeltTask] Attempting to place furnace at ${above}`);
                await this.bot.equip(furnaceItem, 'hand');
                await this.bot.lookAt(pos.offset(0.5, 1, 0.5), false);
                await this.bot.placeBlock(this.bot.blockAt(pos), new Vec3(0, 1, 0));
                require('../lib/Workstations')(this.bot).remember('furnace',above);
                console.log(`[SmeltTask] Furnace placed successfully.`);
                this.bot.chat?.('[SpeedBot] Four pose dans une zone verifiee, sans mobs proches.');
                return this.bot.blockAt(above);
            } catch (err) {
                console.log(`[SmeltTask] Failed to place furnace at ${above}: ${err.message}`);
                // Continue to next spot
            }
        }
        throw new Error("Could not find a valid spot to place furnace");
    }

    async relocateWorkstation() {
        const positions = this.bot.findBlocks({
            matching: ['grass_block', 'dirt', 'stone', 'cobblestone'].map(n => this.mcData.blocksByName[n].id),
            maxDistance: 32, count: 100,
            useExtraInfo: block => !!block?.position &&
                this.bot.blockAt(block.position.offset(0, 1, 0))?.boundingBox === 'empty' &&
                this.bot.blockAt(block.position.offset(0, 2, 0))?.boundingBox === 'empty'
        });
        for (const floor of positions) {
            const target = floor.offset(0, 1, 0);
            if (threatNearPoint(this.bot, target, 6)) continue;
            const goal = new goals.GoalNear(target.x, target.y, target.z, 1);
            const route = await planCompletePath(this.bot, goal);
            if (route.status !== 'success' || threatNearPath(this.bot, route.path) || this.bot.isInCombat?.()) continue;
            this.bot.chat?.('[SpeedBot] Je cherche un emplacement sur pour le four.');
            await withTimeout(this.bot, this.bot.pathfinder.goto(goal), 15000, 'Emplacement du four inaccessible');
            return !threatNearPoint(this.bot, this.bot.entity.position, 4);
        }
        return false;
    }
}

module.exports = SmeltTask;
