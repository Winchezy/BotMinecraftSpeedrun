const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { planCompletePath, withTimeout } = require('../lib/Pathing');
const { threatNearPoint, threatNearPath } = require('../lib/MobSafety');
const { craftBatch } = require('../lib/ResourceAmounts');

function usableTable(bot, block) {
    return !!block?.position && !threatNearPoint(bot, block.position, 3) &&
        (bot.unusableTables?.get(block.position.toString()) || 0) < Date.now();
}

class CraftTask extends Task {
    constructor(bot, itemName, count = 1, dependencyChain = []) {
        super(bot);
        this.name = `Craft_${itemName}`;
        this.itemName = itemName;
        this.count = count;
        this.dependencyChain = [...dependencyChain, itemName];
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        console.log(`[DEBUG] CraftTask running for ${this.itemName}`);
        // Somme sur toutes les piles : les outils ne s'empilent pas (1 par slot).
        const owned = this.bot.inventory.items()
            .filter(i => i.name === this.itemName)
            .reduce((acc, i) => acc + i.count, 0);
        if (owned >= this.count) {
            this.complete();
            return;
        }

        if (this.dependencyTask) {
            const child = this.dependencyTask;
            if (!child.isDone()) await child.run();
            if (child.isDone()) {
                this.dependencyTask = null;
                if (child.hasFailed) this.fail(`Preparation ${child.name} impossible : ${child.failureReason}`);
            }
            return;
        }

        if (['crafting_table','furnace'].includes(this.itemName) &&
            await require('../lib/Workstations')(this.bot).recover(this.itemName)) {this.complete();return;}
        const targetId = this.mcData.itemsByName[this.itemName]?.id;
        if (!targetId) {
            this.fail(`Unknown item ${this.itemName}`);
            return;
        }

        // 1. Try to craft WITHOUT table first (e.g. Planks, Sticks, Crafting Table)
        // FORCE 'stick' to attempt inventory craft aggressively
        const isStick = this.itemName === 'stick';
        const recipesNoTable = this.bot.recipesFor(targetId, null, 1, null);

        if (!recipesNoTable.length && !this.bot.recipesFor(targetId, null, 1, true).length) {
            try {
                this.dependencyTask = require('../lib/CraftDependencies').nextDependency(this.bot,this.itemName,this.dependencyChain);
                if (!this.dependencyTask) { this.fail('Recette indisponible pour '+this.itemName); return; }
                this.bot.chat?.(`[SpeedBot] Pour fabriquer ${this.itemName}, je prepare ${this.dependencyTask.name}.`);
            } catch (error) { this.fail(error.message); }
            return;
        }
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
                    const batches = craftBatch(this.bot, recipesNoTable[0], this.count - owned);
                    if (!batches) { this.fail('Missing ingredients for ' + this.itemName); return; }
                    await this.bot.craft(recipesNoTable[0], batches, null);
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
        let table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id,
            useExtraInfo: block => usableTable(this.bot, block), maxDistance: 4 });
        if (!table && !this.bot.inventory.items().some(i=>i.name==='crafting_table'))
            await require('../lib/Workstations')(this.bot).recover('crafting_table');
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');

        // An owned table can be placed nearby instead of climbing to a distant one.
        if (!table && tableItem) {
            console.log("[CraftTask] Placing required crafting table nearby...");
            await this.placeTable(tableItem);
            table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 4 });
        }

        if (!table && !tableItem) {
            table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id,
                useExtraInfo: block => usableTable(this.bot, block), maxDistance: 32 });
        }

        if (!table) {
            if (!tableItem && this.itemName !== 'crafting_table')
                this.dependencyTask = new CraftTask(this.bot,'crafting_table',1,this.dependencyChain);
            else this.fail("Table required/not found for " + this.itemName);
            return;
        }

        // Go to table
        if (this.bot.entity.position.distanceTo(table.position) > 3 || !this.bot.canSeeBlock(table)) {
            console.log(`[CraftTask] Walking to table at ${table.position}...`);
            try {
                const goal = new goals.GoalLookAtBlock(table.position, this.bot.world, { reach: 3 });
                const route = await planCompletePath(this.bot, goal);
                if (route.status !== 'success' || threatNearPath(this.bot, route.path)) throw new Error('Aucun acces sur a la table');
                await withTimeout(this.bot, this.bot.pathfinder.goto(goal), 15000, 'Acces a la table trop long');
            } catch (e) {
                this.rejectTable(table);
                this.fail(`Path to table failed: ${e.message}`);
                return;
            }
        }

        if (!this.bot.canSeeBlock(table) || this.bot.entity.position.distanceTo(table.position) > 4 ||
            threatNearPoint(this.bot, table.position, 3) || this.bot.isInCombat?.()) {
            this.rejectTable(table);
            this.fail('Table inaccessible pour fabriquer ' + this.itemName);
            return;
        }

        // Craft with table
        const recipesTable = this.bot.recipesFor(targetId, null, 1, table);
        if (recipesTable.length > 0) {
            try {
                const batches = craftBatch(this.bot, recipesTable[0], this.count - owned);
                if (!batches) { this.fail('Missing ingredients for ' + this.itemName); return; }
                await this.bot.craft(recipesTable[0], batches, table);
                console.log(`Crafted ${this.itemName} using table`);
                return;
            } catch (e) {
                this.rejectTable(table);
                this.fail(`Table craft failed: ${e.message}`);
            }
        } else {
            // Debug why
            const allRecipes = this.bot.recipesAll(targetId, null, table);
            if (allRecipes.length > 0) {
                this.fail(`Missing ingredients for ${this.itemName} (Needs table=${!!table})`);
            } else {
                this.fail(`No recipes found for ${this.itemName}`);
            }
        }
    }

    rejectTable(table) {
        this.bot.unusableTables ||= new Map();
        this.bot.unusableTables.set(table.position.toString(), Date.now() + 120000);
        this.bot.chat?.('[SpeedBot] Table inaccessible : je prepare une table a proximite.');
    }

    async placeTable(tableItem) {
        const { Vec3 } = require('vec3');
        const botPos = this.bot.entity.position.floored();
        if (threatNearPoint(this.bot, botPos, 3) || this.bot.isInCombat?.()) return;

        // Strategy 1: Find existing open spot
        // Try to place on the block right in front/side of us
        const nearby = this.bot.findBlocks({
            matching: b => b.boundingBox === 'block' && b.name !== 'air',
            maxDistance: 3,
            count: 30
        });

        for (const pos of nearby) {
            // Check if space above is air
            const above = pos.offset(0, 1, 0);
            const blockAbove = this.bot.blockAt(above);

            // Should be air (or explicit transparent), and not where we are standing
            if (blockAbove && blockAbove.name === 'air' && Math.abs(above.y - botPos.y) <= 1 &&
                !/lava|magma|fire/.test(this.bot.blockAt(pos)?.name || '') && !threatNearPoint(this.bot, above, 3)) {
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
                        require('../lib/Workstations')(this.bot).remember('crafting_table',above);
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
            if (block && ['stone', 'dirt', 'cobblestone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite'].includes(block.name) &&
                this.bot.blockAt(targetPos.offset(0, -1, 0))?.boundingBox === 'block' &&
                [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,1,0), new Vec3(0,0,1), new Vec3(0,0,-1)].every(delta => {
                    const neighbor = this.bot.blockAt(targetPos.plus(delta));
                    return neighbor && !/water|lava|gravel|sand/.test(neighbor.name);
                })) {
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
                        require('../lib/Workstations')(this.bot).remember('crafting_table',targetPos);
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
module.exports.usableTable = usableTable;
