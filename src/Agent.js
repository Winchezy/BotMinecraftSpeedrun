const GetWood = require('./tasks/GetWood');
const CraftTask = require('./tasks/CraftTask');
const MineBlock = require('./tasks/MineBlock');
const SmeltTask = require('./tasks/SmeltTask');
const FightMob = require('./tasks/FightMob');
const BuildNetherPortal = require('./tasks/BuildNetherPortal');
const FindStronghold = require('./tasks/FindStronghold');
const FightDragon = require('./tasks/FightDragon');
const MoveToSurface = require('./tasks/MoveToSurface');

class Agent {
    constructor(bot) {
        this.bot = bot;
        this.currentTask = null;
        this.mcData = require('minecraft-data')(bot.version);
        this.stage = 'EARLY_GAME'; // EARLY_GAME, IRON, DIAMOND, NETHER, STRONGHOLD, END
        this.failedTasks = {}; // Track failed tasks to avoid infinite loops

        // Chat Listener for Status Updates
        this.bot.on('chat', (username, message) => {
            if (username === this.bot.username) return;

            const msg = message.toLowerCase();
            if (msg.includes('!status')) {
                this.bot.chat(`Health: ${this.bot.health.toFixed(0)}/20 | Food: ${this.bot.food.toFixed(0)}/20 | Task: ${this.currentTask ? this.currentTask.name : 'Idle'}`);
            }
            if (msg.includes('!inv') || msg.includes('!inventory')) {
                const items = this.bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ');
                if (items.length === 0) {
                    this.bot.chat("Inventory is empty.");
                } else {
                    // Split into chunks of 240 chars (safe limit for MC chat)
                    const chunks = items.match(/.{1,240}/g) || [];
                    chunks.forEach((chunk, index) => {
                        this.bot.chat(`Inv [${index + 1}/${chunks.length}]: ${chunk}`);
                    });
                }
            }
            if (msg.includes('!pos')) {
                this.bot.chat(`Pos: ${this.bot.entity.position.floored()}`);
            }
        });
    }

    async tick() {
        if (this.bot.isInCombat && this.bot.isInCombat()) {
            console.log("[Agent] In Combat! Pausing tasks.");
            return;
        }

        if (this.currentTask) {
            console.log(`[DEBUG] Tick: Current task is ${this.currentTask.name}, done=${this.currentTask.isDone()}`);
        } else {
            console.log(`[DEBUG] Tick: No current task`);
        }

        if (this.currentTask && !this.currentTask.isDone()) {
            try {
                await this.currentTask.run();
            } catch (err) {
                console.log(`Task Error: ${err.message}`);
                // Track failed tasks
                const taskName = this.currentTask.name;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + 1;
                this.currentTask = null;
            }
            return;
        }

        // If current task is done, check if it failed
        if (this.currentTask && this.currentTask.isDone()) {
            if (this.currentTask.hasFailed) {
                const taskName = this.currentTask.name;
                this.failedTasks[taskName] = (this.failedTasks[taskName] || 0) + 1;
            }
            this.currentTask = null;
        }

        this.decideNext();
    }

    async decideNext() {
        // Check if bot is in water - if so, wait for survival system to get us out
        // Check if bot is in water - if so, wait for survival system to get us out
        /*
        const pos = this.bot.entity.position;
        const feetBlock = this.bot.blockAt(pos.floored());
        const headBlock = this.bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        if (inWater) {
            console.log('[Agent] Waiting for bot to escape water before starting new tasks...');
            await this.bot.waitForTicks(20);
            return;
        }
        */

        const inv = this.bot.inventory.items();
        const summary = inv.map(i => `${i.name}x${i.count}`).join(', ');
        console.log(`[Agent] Stage: ${this.stage} | Inventory: ${summary.substring(0, 100)}...`);

        const has = (name) => inv.some(i => {
            if (name === 'cobblestone') return i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name === 'blackstone';
            return i.name.includes(name);
        });
        const count = (name) => inv.filter(i => {
            if (name === 'cobblestone') return i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name === 'blackstone';
            return i.name.includes(name);
        }).reduce((a, b) => a + b.count, 0);

        // ========== STAGE: EARLY_GAME ==========
        if (this.stage === 'EARLY_GAME') {
            const hasPick = has('stone_pickaxe');
            const hasSword = inv.some(i => i.name.includes('sword'));

            // Get stone pickaxe AND sword
            if (!hasPick || !hasSword) {
                // If stone_pickaxe craft failed more than 5 times, skip to IRON with wooden pickaxe
                // (Only skip if we at least have a pickaxe)
                if ((this.failedTasks['Craft_stone_pickaxe'] || 0) > 5 && has('wooden_pickaxe')) {
                    console.log("[Agent] Stone pickaxe craft failed multiple times, skipping to IRON stage with wooden pickaxe.");
                    this.stage = 'IRON';
                    return;
                }

                await this.handleEarlyGame(inv, has, count);
                return;
            }
            console.log("[Agent] Early game complete! Moving to IRON stage.");
            this.stage = 'IRON';
        }

        // ========== STAGE: IRON ==========
        if (this.stage === 'IRON') {
            if (!has('iron_pickaxe')) {
                await this.handleIronStage(inv, has, count);
                return;
            }
            console.log("[Agent] Iron stage complete! Moving to DIAMOND stage.");
            this.stage = 'DIAMOND';
        }

        // ========== STAGE: DIAMOND ==========
        if (this.stage === 'DIAMOND') {
            if (!has('diamond_pickaxe')) {
                this.handleDiamondStage(inv, has, count);
                return;
            }
            console.log("[Agent] Diamond stage complete! Moving to NETHER stage.");
            this.stage = 'NETHER';
        }

        // ========== STAGE: NETHER ==========
        if (this.stage === 'NETHER') {
            if (count('blaze_rod') < 6 || count('ender_pearl') < 12) {
                this.handleNetherStage(inv, has, count);
                return;
            }
            console.log("[Agent] Nether stage complete! Moving to STRONGHOLD stage.");
            this.stage = 'STRONGHOLD';
        }

        // ========== STAGE: STRONGHOLD ==========
        if (this.stage === 'STRONGHOLD') {
            const endPortal = this.bot.findBlock({
                matching: this.mcData.blocksByName.end_portal?.id,
                maxDistance: 16
            });
            if (!endPortal) {
                this.handleStrongholdStage(inv, has, count);
                return;
            }
            console.log("[Agent] Stronghold found! Moving to END stage.");
            this.stage = 'END';
        }

        // ========== STAGE: END (Fight Dragon) ==========
        if (this.stage === 'END') {
            this.handleEndStage(inv, has, count);
            return;
        }

        console.log("[Agent] VICTORY! Ender Dragon defeated!");
    }

    // ==================== EARLY GAME ====================
    async handleEarlyGame(inv, has, count) {
        // 1. Get Wood
        if (count('log') < 3 && count('planks') < 5 && !has('wooden_pickaxe')) {
            console.log("Goal: Get Wood");
            this.currentTask = new GetWood(this.bot, 3);
            return;
        }

        // 2. Craft Planks
        if (count('planks') < 8 && !has('crafting_table') && !has('wooden_pickaxe')) {
            if (count('log') === 0 && count('planks') < 4) {
                // Check if we have logs to craft planks
                console.log("[Agent] Need planks but no logs! Going to GetWood.");
                this.currentTask = new GetWood(this.bot, 3);
                return;
            }

            console.log("Goal: Craft Planks");
            let targetPlank = 'oak_planks';
            const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
            if (logItem) {
                targetPlank = `${logItem.name.replace('_log', '')}_planks`;
            }
            this.currentTask = new CraftTask(this.bot, targetPlank, 8);
            return;
        }

        // 3. Craft Table
        if (!has('crafting_table') && !has('wooden_pickaxe')) {
            console.log("Goal: Craft Table");
            this.currentTask = new CraftTask(this.bot, 'crafting_table');
            return;
        }

        // 4. Craft Sticks + Wooden Pickaxe
        if (!has('wooden_pickaxe') && !has('stone_pickaxe')) {
            if (count('stick') < 2) {
                if (count('planks') < 2) {
                    console.log("[Agent] Need sticks but no planks! Going to GetWood.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
                console.log("Goal: Craft Sticks");
                this.currentTask = new CraftTask(this.bot, 'stick', 2);
                return;
            }

            // Check for Planks (Need 3 for Pickaxe)
            if (count('planks') < 3) {
                if (count('log') > 0) {
                    console.log("Goal: Craft Planks for Pickaxe");
                    let targetPlank = 'oak_planks';
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    if (logItem) {
                        targetPlank = `${logItem.name.replace('_log', '')}_planks`;
                    }
                    this.currentTask = new CraftTask(this.bot, targetPlank, 4); // Craft 1 batch (4 planks)
                    return;
                } else {
                    console.log("[Agent] Need planks for pickaxe but no logs! Going to GetWood.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
            }

            console.log("Goal: Craft Wooden Pickaxe");
            this.currentTask = new CraftTask(this.bot, 'wooden_pickaxe');
            return;
        }

        // 5. Mine Stone
        // Ensure we have a backup pickaxe if we are going to mine stone heavily
        if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

        if (!has('stone_pickaxe')) {
            if (count('cobblestone') < 3) {
                console.log("Goal: Mine Stone");
                this.currentTask = new MineBlock(this.bot, 'stone', 3);
                return;
            }

            // Ensure sticks
            if (count('stick') < 2) {
                console.log("Goal: Craft Sticks for Stone Pickaxe");
                this.currentTask = new CraftTask(this.bot, 'stick', 4);
                return;
            }

            console.log("Goal: Craft Stone Pickaxe");
            this.currentTask = new CraftTask(this.bot, 'stone_pickaxe');
            return;
        }

        // 6. Craft Stone Sword (Defense)
        const hasSword = inv.some(i => i.name.includes('sword'));
        if (!hasSword) {
            const cobbleCount = count('cobblestone');
            console.log(`[Agent] Checking sword: cobblestone=${cobbleCount}, need=2`);

            if (cobbleCount < 2) {
                console.log("Goal: Mine Stone for Sword");
                this.currentTask = new MineBlock(this.bot, 'stone', 2);
                return;
            }
            if (count('stick') < 1) {
                console.log("Goal: Craft Stick for Sword");
                this.currentTask = new CraftTask(this.bot, 'stick', 4);
                return;
            }

            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            console.log("Goal: Craft Stone Sword");
            this.currentTask = new CraftTask(this.bot, 'stone_sword');
            return;
        }
    }

    // ==================== IRON STAGE ====================
    async handleIronStage(inv, has, count) {
        // CRITICAL: If we have NO pickaxe, reset to EARLY_GAME
        const pickaxes = inv.filter(i => i.name.includes('pickaxe'));
        if (pickaxes.length === 0) {
            console.log("[Agent] CRITICAL: No pickaxe found! Resetting to EARLY_GAME.");
            this.stage = 'EARLY_GAME';
            return;
        }

        // Ensure backup stone pickaxe if we are deep down
        if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

        // 1. Mine Iron Ore (need 6 for pickaxe + shield + sword)
        if (count('raw_iron') < 6 && count('iron_ingot') < 6) {
            console.log("Goal: Mine Iron Ore");
            this.currentTask = new MineBlock(this.bot, 'iron_ore', 6);
            return;
        }


        // 2a. Craft Shield - TEMPORARILY DISABLED (infinite loop with GetWood)
        // Will re-enable once GetWood task is fixed
        /*
        if (!has('shield') && count('iron_ingot') >= 1) {
            const totalPlanks = count('planks');
            if (totalPlanks < 6) {
                const logsAvailable = count('log');
                console.log(`\n\n========== SHIELD CHECK ==========`);
                console.log(`Planks: ${totalPlanks}/6, Logs: ${logsAvailable}`);
                
                if (logsAvailable < 2) {
                    const logsNeeded = 2 - logsAvailable;
                    console.log(`Goal: Get Wood for Shield (need ${logsNeeded} more logs)`);
                    this.currentTask = new GetWood(this.bot, logsNeeded);
                    return;
                } else {
                    console.log("Goal: Craft Planks for Shield (have enough logs)");
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                    this.currentTask = new CraftTask(this.bot, plankType, 2);
                    return;
                }
            }

            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            console.log("Goal: Craft Shield");
            this.currentTask = new CraftTask(this.bot, 'shield');
            return;
        }
        */


        // 2. Craft Furnace (or skip if fails too many times OR if we already have 3 iron ingots)
        console.log(`[DEBUG] has(furnace): ${has('furnace')}, failed(Craft_furnace): ${this.failedTasks['Craft_furnace'] || 0}`);
        if (!has('furnace') && count('iron_ingot') < 6) {
            // Check if we already have a furnace placed nearby
            const nearbyFurnace = this.bot.findBlock({
                matching: this.mcData.blocksByName.furnace?.id,
                maxDistance: 32
            });

            if (nearbyFurnace) {
                console.log("[DEBUG] Found placed furnace nearby, skipping craft.");
            } else {
                // Ensure we have a crafting table first (or wood to make one)
                await this.ensureTable(inv, has, count);
                if (this.currentTask) return;

                // If furnace craft failed more than 5 times AND we have a placed furnace nearby, skip
                if ((this.failedTasks['Craft_furnace'] || 0) > 5) {
                    const furnaceBlock = this.bot.findBlock({
                        matching: this.mcData.blocksByName.furnace?.id,
                        maxDistance: 64
                    });
                    if (furnaceBlock) {
                        console.log("[Agent] Furnace craft failed multiple times, but found placed furnace nearby. Continuing.");
                    } else {
                        console.log("[Agent] Furnace craft failed multiple times. Moving to surface to find better location.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return;
                    }
                } else {
                    if (count('cobblestone') < 8) {
                        console.log("Goal: Mine Cobblestone for Furnace");
                        this.currentTask = new MineBlock(this.bot, 'stone', 8);
                        return;
                    }
                    console.log("Goal: Craft Furnace");
                    console.log("[DEBUG] Setting task: Craft_furnace");
                    this.currentTask = new CraftTask(this.bot, 'furnace');
                    return;
                }
            }
        }

        // 3. Smelt Iron (target changed to 6 for all equipment)
        if (count('iron_ingot') < 6) {
            const smeltTaskName = 'Smelt_raw_iron_to_iron_ingot';
            if ((this.failedTasks[smeltTaskName] || 0) > 2) {
                console.log("[Agent] Smelting failed multiple times. Trying to move to better location.");
                this.failedTasks[smeltTaskName] = 0;
                this.currentTask = new MoveToSurface(this.bot);
                return;
            }

            console.log("Goal: Smelt Iron");

            // CHECK FOR FUEL
            // If we check for fuel in inventory.
            const fuels = inv.filter(i =>
                i.name.includes('coal') ||
                i.name.includes('log') ||
                i.name.includes('planks') ||
                i.name.includes('charcoal')
            );

            if (fuels.length === 0) {
                console.log("[Agent] Need to smelt but have NO FUEL detected in inventory.");

                // User Requirement: "look for coal in the caves"
                // 1. Ensure we have a pickaxe to mine coal
                if (await this.ensurePickaxeRedundancy(inv, has, count)) return;

                // 2. Try to find Coal Ore nearby
                const coalOre = this.bot.findBlock({
                    matching: ['coal_ore', 'deepslate_coal_ore'].map(name => this.mcData.blocksByName[name].id),
                    maxDistance: 32
                });

                if (coalOre) {
                    console.log("[Agent] Found Coal Ore nearby! Mining for fuel.");
                    this.currentTask = new MineBlock(this.bot, 'coal_ore', 3);
                    return;
                } else {
                    console.log("[Agent] No Coal Ore found nearby. Checking surface/wood fallback.");
                    // If we are deep underground and no coal, we must surface.
                    if (this.bot.entity.position.y < 60) {
                        console.log("[Agent] Underground, no coal, no fuel. Returning to surface for wood/survival.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return;
                    }
                    // If on surface, get wood
                    console.log("[Agent] On surface (or close). getting wood for fuel.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return;
                }
            }

            // CRITICAL: If we have fuel but are underground, GO TO SURFACE FIRST
            if (this.bot.entity.position.y < 60) {
                console.log("[Agent] Have fuel for smelting but UNDERGROUND! Moving to surface first.");
                this.currentTask = new MoveToSurface(this.bot);
                return;
            }

            this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 6);
            return;
        }

        // 4. Craft Iron Pickaxe
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return;

        if (count('stick') < 2) {
            // Do we have planks?
            if (count('planks') < 2) {
                // Do we have logs?
                if (count('log') > 0) {
                    const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                    let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                    console.log(`Goal: Craft Planks for Sticks`);
                    this.currentTask = new CraftTask(this.bot, plankType, 4);
                    return;
                }
            }
            console.log("Goal: Craft Sticks");
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        console.log("Goal: Craft Iron Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'iron_pickaxe');
        return;

        // Iron Sword crafting (after pickaxe)
        if (!has('iron_sword')) {
            await this.ensureTable(inv, has, count);
            if (this.currentTask) return;

            if (count('stick') < 1) {
                if (count('planks') < 2) {
                    if (count('log') > 0) {
                        const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                        let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                        console.log(`Goal: Craft Planks for Iron Sword`);
                        this.currentTask = new CraftTask(this.bot, plankType, 1);
                        return;
                    }
                }
                console.log("Goal: Craft Stick for Iron Sword");
                this.currentTask = new CraftTask(this.bot, 'stick', 1);
                return;
            }

            console.log("Goal: Craft Iron Sword");
            this.currentTask = new CraftTask(this.bot, 'iron_sword');
            return;
        }
    }

    // ==================== DIAMOND STAGE ====================
    async handleDiamondStage(inv, has, count) {
        // Recovery: If we died and lost our pickaxe, we need to go back
        if (!has('iron_pickaxe') && !has('diamond_pickaxe')) {
            console.log("[Agent] In Diamond Stage but lost pickaxe! Reverting to Iron gear recovery.");
            // Fallback to iron stage logic temporarily
            await this.handleIronStage(inv, has, count);
            return;
        }

        // Mine diamonds (need to go deep, y < 16)
        if (count('diamond') < 3) {
            // Need to go deep?
            if (this.bot.entity.position.y > 16) {
                console.log("Goal: Go Deep for Diamonds");
                const DigDown = require('./tasks/DigDown');
                this.currentTask = new DigDown(this.bot, -54); // Go to -54 (deepslate)
                return;
            }

            console.log("Goal: Mine Diamonds");
            this.currentTask = new MineBlock(this.bot, 'diamond_ore', 3);
            return;
        }

        // Craft Diamond Pickaxe
        this.ensureTable(inv, has, count);
        if (this.currentTask) return;

        if (count('stick') < 2) {
            this.currentTask = new CraftTask(this.bot, 'stick', 2);
            return;
        }

        console.log("Goal: Craft Diamond Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'diamond_pickaxe');
    }

    // ==================== NETHER STAGE ====================
    handleNetherStage(inv, has, count) {
        // 1. Get Obsidian (need 10)
        if (count('obsidian') < 10) {
            // Need bucket + water + lava, or mine directly
            console.log("Goal: Mine Obsidian");
            this.currentTask = new MineBlock(this.bot, 'obsidian', 10);
            return;
        }

        // 2. Craft Flint and Steel
        if (!has('flint_and_steel')) {
            if (!has('flint')) {
                console.log("Goal: Mine Gravel for Flint");
                this.currentTask = new MineBlock(this.bot, 'gravel', 5);
                return;
            }
            if (count('iron_ingot') < 1) {
                this.currentTask = new SmeltTask(this.bot, 'raw_iron', 'iron_ingot', 1);
                return;
            }
            console.log("Goal: Craft Flint and Steel");
            this.currentTask = new CraftTask(this.bot, 'flint_and_steel');
            return;
        }

        // 3. Build Portal
        const portal = this.bot.findBlock({
            matching: this.mcData.blocksByName.nether_portal?.id,
            maxDistance: 64
        });
        if (!portal) {
            console.log("Goal: Build Nether Portal");
            this.currentTask = new BuildNetherPortal(this.bot);
            return;
        }

        // 4. Enter Nether & Find Blaze
        if (count('blaze_rod') < 6) {
            console.log("Goal: Hunt Blazes");
            this.currentTask = new FightMob(this.bot, 'blaze', 6);
            return;
        }

        // 5. Get Ender Pearls (from Endermen or Piglins)
        if (count('ender_pearl') < 12) {
            console.log("Goal: Get Ender Pearls");
            this.currentTask = new FightMob(this.bot, 'enderman', 12);
            return;
        }

        // 6. Craft Eyes of Ender
        if (count('ender_eye') < 12) {
            // Craft blaze powder first
            if (count('blaze_powder') < 12) {
                console.log("Goal: Craft Blaze Powder");
                this.currentTask = new CraftTask(this.bot, 'blaze_powder', 12);
                return;
            }
            console.log("Goal: Craft Eyes of Ender");
            this.currentTask = new CraftTask(this.bot, 'ender_eye', 12);
            return;
        }
    }

    // ==================== STRONGHOLD STAGE ====================
    handleStrongholdStage(inv, has, count) {
        console.log("Goal: Find Stronghold");
        this.currentTask = new FindStronghold(this.bot);
    }

    // ==================== END STAGE ====================
    handleEndStage(inv, has, count) {
        console.log("Goal: Fight Ender Dragon!");
        this.currentTask = new FightDragon(this.bot);
    }

    // ==================== HELPERS ====================
    async ensureTable(inv, has, count) {
        const tableBlock = this.bot.findBlock({
            matching: this.mcData.blocksByName.crafting_table.id,
            maxDistance: 10
        });

        // Table already placed nearby
        if (tableBlock) {
            console.log(`[DEBUG] ensureTable: Found table at ${tableBlock.position}`);
            return;
        }

        // Table in inventory, need to place it
        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (tableItem) {
            console.log("Goal: Place Crafting Table");
            // Place it
            const { Vec3 } = require('vec3');
            const nearby = this.bot.findBlocks({
                matching: b => b.type !== this.mcData.blocksByName.air.id && b.boundingBox === 'block',
                maxDistance: 4,
                count: 10
            });

            for (const pos of nearby) {
                const above = pos.offset(0, 1, 0);
                const blockAbove = this.bot.blockAt(above);
                if (blockAbove && blockAbove.type === this.mcData.blocksByName.air.id) {
                    if (this.bot.entity.position.distanceTo(above) > 1.5) {
                        try {
                            await this.bot.equip(tableItem, 'hand');
                            await this.bot.placeBlock(this.bot.blockAt(pos), new Vec3(0, 1, 0));
                            console.log("Placed crafting table!");
                            return;
                        } catch (e) {
                            console.log(`Place table error: ${e.message}`);
                        }
                    }
                }
            }
            return;
        }

        // No table anywhere, need to craft
        if (count('planks') < 4) {
            if (count('log') < 1) {
                console.log("Goal: Get Wood for Table");
                this.currentTask = new GetWood(this.bot, 2);
                return;
            }
            const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
            let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
            console.log(`Goal: Craft ${plankType}`);
            this.currentTask = new CraftTask(this.bot, plankType, 4);
            return;
        }
        console.log("Goal: Craft Crafting Table");
        this.currentTask = new CraftTask(this.bot, 'crafting_table');
    }

    // Ensure we have at least 2 pickaxes so we don't get stuck mining without one
    async ensurePickaxeRedundancy(inv, has, count) {
        // Only run this check if we are NOT already doing a craft/surface task
        // to avoid recursion loops if we are already fixing it.
        if (this.currentTask && (
            this.currentTask.name.includes('Craft') ||
            this.currentTask.name.includes('Surface') ||
            this.currentTask.name.includes('GetWood')
        )) return false;

        const pickaxes = inv.filter(i => i.name.includes('pickaxe'));
        // If we have 2 or more, we are safe.
        if (pickaxes.length >= 2) return false;

        console.log(`[Agent] Redundancy Check: Only ${pickaxes.length} pickaxe(s). Need backup.`);

        // We need a backup STONE pickaxe (cheapest).
        // Do we have Materials? (3 cobble + 2 sticks)
        // If no cobble -> we are probably early game or just used it all. 
        // If we have existing pickaxe, we can mine cobble.

        // Do we have sticks?
        if (count('stick') < 2) {
            // Need planks?
            if (count('planks') < 2) {
                // Need logs?
                if (count('log') < 1) {
                    // NO WOOD. 
                    // If we are underground, we MUST go to surface.
                    if (this.bot.entity.position.y < 60) {
                        console.log("[Agent] CRITICAL: Single pickaxe, no wood, underground! Initiating emergency surface return.");
                        this.currentTask = new MoveToSurface(this.bot);
                        return true;
                    }
                    // On surface, get wood
                    console.log("[Agent] Single pickaxe, no wood. Getting wood.");
                    this.currentTask = new GetWood(this.bot, 3);
                    return true;
                }
                const logItem = inv.find(i => i.name.includes('log') && !i.name.includes('stripped'));
                let plankType = logItem ? `${logItem.name.replace('_log', '')}_planks` : 'oak_planks';
                console.log("[Agent] Crafting planks for redundancy sticks");
                this.currentTask = new CraftTask(this.bot, plankType, 4);
                return true;
            }
            console.log("[Agent] Crafting sticks for redundancy");
            this.currentTask = new CraftTask(this.bot, 'stick', 4);
            return true;
        }

        // We have sticks. Do we have cobble?
        if (count('cobblestone') < 3) {
            // Can we mine it? Yes if we have ANY pickaxe.
            const hasPick = pickaxes.length > 0;
            if (hasPick) {
                // It's okay to have <3 cobble, we can strip mine or standard mine.
                // But wait, if we are here, we want to PREPARE before a long mine session.
                // Let's just create one if we happen to have cobble. 
                // If we don't have cobble, checking redundancy might be premature unless durability is critically low.
                // Let's assume if we are mining Stone/Iron, we will get cobble soon.
                // So only force craft if we HAVE cobble.
                return false;
            } else {
                // No pickaxe at all? Logic elsewhere handles this (GetWood -> Wooden Pick).
                return false;
            }
        }

        // We have Sticks + Cobble. Need Table?
        await this.ensureTable(inv, has, count);
        if (this.currentTask) return true;

        console.log("[Agent] Crafting backup Stone Pickaxe");
        this.currentTask = new CraftTask(this.bot, 'stone_pickaxe');
        return true;
    }
}

module.exports = Agent;
