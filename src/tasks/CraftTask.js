const Task = require('../lib/Task');

class CraftTask extends Task {
    constructor(bot, itemName, count = 1) {
        super(bot);
        this.name = `Craft_${itemName}`;
        this.itemName = itemName;
        this.count = count;
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        console.log(`[DEBUG] CraftTask running for ${this.itemName}`);
        const totalCount = this.bot.inventory.items()
            .filter(i => i.name === this.itemName)
            .reduce((sum, i) => sum + i.count, 0);
        if (totalCount >= this.count) {
            this.complete();
            return;
        }

        const targetId = this.mcData.itemsByName[this.itemName]?.id;
        if (!targetId) {
            this.fail(`Unknown item ${this.itemName}`);
            return;
        }

        // 1. Try to craft WITHOUT table first (e.g. Planks, Sticks, Crafting Table)
        // FORCE 'stick' to attempt inventory craft aggressively
        const isStick = this.itemName === 'stick';
        const recipesNoTable = this.bot.recipesFor(targetId, null, 1, null);

        if (recipesNoTable.length > 0 || isStick) {
            console.log(`[CraftTask] Crafting ${this.itemName} using inventory (no table needed).`);
            try {
                // If stick, double check we have planks
                if (isStick) {
                    const planks = this.bot.inventory.items().filter(i => i.name.includes('planks'));
                    if (planks.length === 0) {
                        // We might need to craft planks first?
                        // Agent should handle this dependency, but let's be safe.
                        console.log("No planks for sticks! hoping recursion handles it or error.");
                    }
                }

                if (recipesNoTable.length > 0) {
                    await this.bot.craft(recipesNoTable[0], 1, null);
                    console.log(`Crafted ${this.itemName}`);
                    return;
                } else if (isStick) {
                    // Start debugging why recipe lookup failed for stick
                    console.log("RecipesNoTable empty for stick? That's weird. Checking Planks.");
                }
            } catch (e) {
                console.log(`Inventory craft failed: ${e.message}`);
                // Fallthrough to table logic just in case
            }
        }

        // 2. Need Table
        let table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 32 });

        // If we don't have a table placed, check if we have one to place
        if (!table) {
            const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
            if (tableItem) {
                console.log("[CraftTask] Placing required crafting table...");
                await this.placeTable(tableItem);
                table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 4 });
            }
        }

        if (!table) {
            this.fail("Table required/not found for " + this.itemName);
            return;
        }

        // Go to table
        if (this.bot.entity.position.distanceTo(table.position) > 3) {
            console.log(`[CraftTask] Walking to table at ${table.position}...`);
            const { goals } = require('mineflayer-pathfinder');
            try {
                await this.bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
            } catch (e) {
                console.log(`[CraftTask] Table inaccessible (${e.message}), tentative de poser une nouvelle table.`);
                const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
                if (tableItem) {
                    await this.placeTable(tableItem);
                    table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 4 });
                    if (!table) { this.fail('Impossible de poser une table à proximité'); return; }
                } else {
                    this.fail(`Table inaccessible et aucune table en inventaire`);
                    return;
                }
            }
        }

        // Craft with table
        const recipesTable = this.bot.recipesFor(targetId, null, 1, table);
        if (recipesTable.length > 0) {
            try {
                await this.bot.craft(recipesTable[0], 1, table);
                console.log(`Crafted ${this.itemName} using table`);
                return;
            } catch (e) {
                this.fail(`Table craft failed: ${e.message}`);
            }
        } else {
            // Debug why
            const allRecipes = this.bot.recipesAll(targetId, null, table);
            if (allRecipes.length > 0) {
                const invSummary = this.bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ');
                console.log(`[CraftTask] Inventory: ${invSummary}`);
                this.fail(`Missing ingredients for ${this.itemName} (Needs table=${!!table})`);
            } else {
                this.fail(`No recipes found for ${this.itemName}`);
            }
        }
    }

    async placeTable(tableItem) {
        const { Vec3 } = require('vec3');
        const botPos = this.bot.entity.position.floored();

        // Strategy 1: Find existing open spot
        // Try to place on the block right in front/side of us
        const nearby = this.bot.findBlocks({
            matching: b => b.boundingBox === 'block' && b.name !== 'air',
            maxDistance: 5,
            count: 50
        });

        for (const pos of nearby) {
            // Check if space above is air
            const above = pos.offset(0, 1, 0);
            const blockAbove = this.bot.blockAt(above);

            // Should be air (or explicit transparent), and not where we are standing
            if (blockAbove && blockAbove.boundingBox !== 'block') {
                // Check if it's the bot's position (Head or Feet)
                if (above.equals(botPos)) continue; // Feet
                if (above.equals(botPos.offset(0, 1, 0))) continue; // Head

                // Check distance (relaxing the >1.0 check)
                // We just need to be able to reach it (max 4).
                // And not inside us (already checked).
                const dist = this.bot.entity.position.distanceTo(above);
                if (dist < 4.5) {
                    try {
                        console.log(`[CraftTask] Placing table at ${above}`);
                        await this.bot.equip(tableItem, 'hand');
                        await this.bot.placeBlock(this.bot.blockAt(pos), new Vec3(0, 1, 0));
                        await this.bot.waitForTicks(10);
                        return;
                    } catch (e) {
                        console.log(`Place table error: ${e.message}`);
                    }
                }
            }
        }

        // Strategy 2: If no spot, DIG a spot.
        // Look for a wall block at eye level or feet level that is NOT supporting us.
        console.log("[CraftTask] No empty spot for table. Creating space...");

        // Find a block horizontally adjacent to head or feet.
        // Cardinal offsets
        const offsets = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
            new Vec3(1, 1, 0), new Vec3(-1, 1, 0),
            new Vec3(0, 1, 1), new Vec3(0, 1, -1)
        ];

        for (const off of offsets) {
            const targetPos = botPos.plus(off);
            const block = this.bot.blockAt(targetPos);

            // It must be a solid block to dig
            if (block && block.boundingBox === 'block') {
                // Ensure it is not the block under us (shouldn't be, off.y >= 0)
                // Dig it
                try {
                    console.log(`[CraftTask] Digging ${targetPos} to place table.`);
                    await this.bot.dig(block);
                    await this.bot.waitForTicks(5);

                    // Now place table there?
                    // We just made it air. We need to place it ON something.
                    // The block BELOW it might be solid?
                    const belowTarget = targetPos.offset(0, -1, 0);
                    const blockBelow = this.bot.blockAt(belowTarget);

                    if (blockBelow && blockBelow.boundingBox === 'block') {
                        console.log(`[CraftTask] Placing table in created spot at ${targetPos}`);
                        await this.bot.equip(tableItem, 'hand');
                        await this.bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
                        await this.bot.waitForTicks(10);
                        return;
                    } else {
                        // Weird, we dug a wall but there is no floor?
                        // Maybe place against side of neighbor?
                        // Too complex, just retry loop next time.
                    }
                } catch (e) {
                    console.log(`[CraftTask] Dig/Place error: ${e.message}`);
                }
            }
        }

        console.log("[CraftTask] Could not find AND could not create spot for table.");
    }
}

module.exports = CraftTask;
