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
                    await furnaceBlock.putFuel(fuel.type, null, (fuel.name.includes('pickaxe') || fuel.name.includes('sword')) ? 1 : Math.min(fuel.count, 8));
                } catch (err) {
                    console.log(`[${this.name}] Failed to put fuel: ${err.message}`);
                }
            } else {
                console.log(`[${this.name}] No fuel available in inventory.`);
                furnaceBlock.close();
                this.fail("No fuel available");
                return;
            }
        }

        // Add input items
        const input = this.bot.inventory.items().find(i => i.name === this.inputItem);
        if (input) {
            const amountToSmelt = Math.min(input.count, this.count - outputCount);
            if (amountToSmelt > 0) {
                console.log(`[${this.name}] Adding input: ${input.name} x${amountToSmelt}`);
                try {
                    await furnaceBlock.putInput(input.type, null, amountToSmelt);
                } catch (err) {
                    console.log(`[${this.name}] Failed to put input: ${err.message}`);
                }
            }
        }

        // Monitor smelting
        console.log(`[${this.name}] Monitoring smelting...`);
        const maxTicks = 200; // 10 seconds per cycle
        let ticks = 0;

        while (ticks < maxTicks) {
            await this.bot.waitForTicks(20);
            ticks += 20;

            if (furnaceBlock.outputItem()) {
                console.log(`[${this.name}] Taking output: ${furnaceBlock.outputItem().name}`);
                await furnaceBlock.takeOutput();
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

        furnaceBlock.close();
    }

    async placeFurnace(furnaceItem) {
        const { Vec3 } = require('vec3');
        console.log(`[SmeltTask] Looking for spot to place furnace...`);

        const nearby = this.bot.findBlocks({
            matching: b => b.type !== this.mcData.blocksByName.air.id &&
                b.boundingBox === 'block' &&
                b.name !== 'crafting_table', // Avoid placing on crafting table
            maxDistance: 5,
            count: 20
        });

        for (const pos of nearby) {
            const above = pos.offset(0, 1, 0);
            const blockAbove = this.bot.blockAt(above);

            // Check if space above is clear
            if (blockAbove && blockAbove.type === this.mcData.blocksByName.air.id) {
                // Ensure bot is not standing in the way (check distance to center of placement)
                const centerAbove = above.offset(0.5, 0.5, 0.5);
                if (this.bot.entity.position.distanceTo(centerAbove) > 2.0) {
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
            }
        }
        throw new Error("Could not find a valid spot to place furnace");
    }
}

module.exports = SmeltTask;
