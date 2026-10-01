const Task = require('../lib/Task');
const { protectedBlocks } = require('../lib/Survival');

const failedBlockPositions = new Map(); // Key: "x,y,z", Value: fail count

// Global underwater retry counter (resets only when task completes or bot reaches surface)
let underwaterRetries = 0;

class MineBlock extends Task {
    constructor(bot, blockName, count = 1) {
        super(bot);
        this.name = `Mine_${blockName}`;
        this.blockName = blockName;
        this.count = count;
        this.mcData = require('minecraft-data')(bot.version);
        this.retries = 0; // Track failed attempts
        this.maxRetries = 3;
        this.maxBlockFailures = 3; // Skip block after 3 failures
    }

    async run() {
        // Check if we're stuck underwater - abort and go to surface
        const pos = this.bot.entity.position;
        const feetBlock = this.bot.blockAt(pos.floored());
        const headBlock = this.bot.blockAt(pos.offset(0, 1.6, 0).floored());
        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        if (inWater && underwaterRetries >= 3) {
            console.log(`[${this.name}] STUCK UNDERWATER after ${underwaterRetries} retries! Aborting task.`);
            underwaterRetries = 0; // Reset counter
            this.fail('Stuck underwater - needs surface');
            return;
        }

        // Count current items - handle ore -> drop conversions (see countCollected)
        const currentCount = this.countCollected();

        console.log(`[${this.name}] Current: ${currentCount}/${this.count}`);

        if (currentCount >= this.count) {
            console.log(`[${this.name}] Goal reached! Completing task.`);
            this.complete();
            return;
        }

        // Find Block
        // Find Block - Enhanced Search for SAFETY
        let ids = [this.mcData.blocksByName[this.blockName]?.id];
        if (this.blockName === 'stone') {
            ids.push(this.mcData.blocksByName['cobblestone']?.id);
            ids.push(this.mcData.blocksByName['deepslate']?.id);
            ids.push(this.mcData.blocksByName['cobbled_deepslate']?.id);
            ids.push(this.mcData.blocksByName['blackstone']?.id);
        }
        if (this.blockName === 'iron_ore') {
            ids.push(this.mcData.blocksByName['deepslate_iron_ore']?.id);
        }
        if (this.blockName === 'diamond_ore') {
            ids.push(this.mcData.blocksByName['deepslate_diamond_ore']?.id);
        }

        // Find multiple candidates to filter
        const candidates = this.bot.findBlocks({
            matching: ids.filter(i => i),
            maxDistance: 32, // Reduced range to focus nearby
            count: 50 // Check top 50
        });

        if (candidates.length === 0) {
            console.log(`[${this.name}] No visible ${this.blockName}. Switching to STAIRCASE mining.`);
            await this.mineStaircase();
            return;
        }


        let block = null;
        const botPos = this.bot.entity.position.floored();
        const blockUnderFeet = botPos.offset(0, -1, 0);
        const blockAboveHead = botPos.offset(0, 2, 0);

        for (const pos of candidates) {
            // Check 0a: PROTECTED BLOCKS - Skip water blockers
            const posKey = `${pos.x},${pos.y},${pos.z}`;
            if (protectedBlocks.has(posKey)) {
                continue; // NEVER mine water-blocking blocks
            }

            // Check 0b: BLACKLIST - Skip blocks that failed too many times
            if (failedBlockPositions.has(posKey) && failedBlockPositions.get(posKey) >= this.maxBlockFailures) {
                continue; // Skip this block
            }

            // Check 1: Under feet validation
            if (pos.equals(blockUnderFeet) || pos.equals(blockAboveHead) || pos.equals(botPos)) continue;

            // Check 2: WATER PROXIMITY CHECK (only direct neighbors)
            let nearWater = false;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const checkBlock = this.bot.blockAt(pos.offset(dx, dy, dz));
                        if (checkBlock && checkBlock.name.includes('water')) {
                            nearWater = true;
                            break;
                        }
                    }
                    if (nearWater) break;
                }
                if (nearWater) break;
            }
            if (nearWater) continue;

            // Valid block found
            block = this.bot.blockAt(pos);
            break;
        }

        if (!block) {
            this.retries++;
            console.log(`[${this.name}] Candidates found but filtered out (SeaLevel/Safety). Retry ${this.retries}/${this.maxRetries}`);

            if (this.retries >= this.maxRetries) {
                console.log(`[${this.name}] Max retries reached. FORCING STAIRCASE mining.`);
                this.retries = 0; // Reset for next task
                await this.mineStaircase();
                return;
            }

            await this.wander();
            return;
        }

        // Reset retries on success
        this.retries = 0;
        console.log(`[${this.name}] Found safe ${block.name} at ${block.position}`);



        // CRITICAL SAFETY: NEVER mine blocks above (lava/gravel risk!)
        if (block.position.y > botPos.y) {
            console.log(`[${this.name}] DANGER: Block is ABOVE us (Y=${block.position.y} > ${botPos.y})! Rejecting for safety (lava risk).`);
            await this.wander();
            return;
        }

        if (block.position.equals(blockAboveHead)) {
            console.log(`[${this.name}] STRICT SAFETY: Block is directly above head! Wandering to get better angle.`);
            await this.wander();
            return;
        }

        // Also check feet level just in case (Y)
        if (block.position.equals(botPos)) {
            console.log(`[${this.name}] STRICT SAFETY: Block is at feet level (inside bot)! Moving.`);
            await this.wander();
            return;
        }

        // Move close to block first
        // SAFETY: If block is above us, don't stand directly under it (lava/gravel risk)
        let goalPos = block.position;
        const isAbove = block.position.y > this.bot.entity.position.y + 1.5;

        if (isAbove) {
            // Find a neighbor spot that is NOT under the block
            // We want to be within 4 blocks but not at offset(0, -y, 0)
            // Just offset the goal by 1-2 blocks horizontally
            goalPos = block.position.offset(1, -1, 0);
            // Check if that offset is valid/walkable? 
            // Simpler: Just ensure we are not strictly consistent x/z
        }

        const distance = this.bot.entity.position.distanceTo(goalPos);

        // If block is below us (y < bot.y), we MUST NOT stand on top of it.
        // We must stand to the side.
        const isBelow = block.position.y < this.bot.entity.position.y;

        if (distance > 4 || (isBelow && this.bot.entity.position.distanceSquared(new (require('vec3'))(block.position.x, this.bot.entity.position.y, block.position.z)) < 2.0)) {
            const { goals } = require('mineflayer-pathfinder');
            try {
                // If below, strictly go to the side (offset 2 blocks)
                const goal = isBelow
                    ? new goals.GoalNear(block.position.x + 1, block.position.y + 1, block.position.z, 0.5)
                    // Note: +1y because we want to stand ON the block next to it, which is same level as bot
                    : new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3);

                // Better: Just pick a spot 2 blocks away at same Y level
                if (isBelow) {
                    console.log(`[${this.name}] Block is below. Moving to side to mine safely.`);
                    try {
                        await Promise.race([
                            this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, this.bot.entity.position.y, block.position.z, 2.5)),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                        ]);
                    } catch (e) {
                        console.log(`[${this.name}] Impossible d'atteindre le côté du bloc (${e.message}). Blacklist.`);
                        const posKey = `${block.position.x},${block.position.y},${block.position.z}`;
                        failedBlockPositions.set(posKey, this.maxBlockFailures);
                        return;
                    }
                } else {
                    await this.bot.pathfinder.goto(goal);
                }
            } catch (e) {
                console.log(`[${this.name}] Pathfind error: ${e.message}`);
            }
        }

        // Re-check after moving - bot position may have changed
        const newBotPos = this.bot.entity.position.floored();
        const newBlockUnderFeet = newBotPos.offset(0, -1, 0);
        if (block.position.equals(newBlockUnderFeet)) {
            console.log(`[${this.name}] After moving, block is now under feet! Skipping.`);
            return;
        }

        // Equip Tool
        await this.equipBestTool(block);

        try {
            // Race collect with timeout (increased to 30s)
            const collectPromise = this.bot.collectBlock.collect(block);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000));

            await Promise.race([collectPromise, timeoutPromise]);
            console.log(`[${this.name}] Collect finished.`);
        } catch (err) {
            console.log(`[${this.name}] Dig error: ${err.message}`);

            // Increment retry counter
            this.retries++;

            // Increment GLOBAL underwater retry counter if we're in water
            const pos = this.bot.entity.position;
            const feetBlock = this.bot.blockAt(pos.floored());
            const headBlock = this.bot.blockAt(pos.offset(0, 1.6, 0).floored());
            const inWater = (feetBlock && feetBlock.name.includes('water')) ||
                (headBlock && headBlock.name.includes('water'));

            if (inWater) {
                underwaterRetries++;
            }

            // Add block to blacklist
            const posKey = `${block.position.x},${block.position.y},${block.position.z}`;
            const currentFails = failedBlockPositions.get(posKey) || 0;
            failedBlockPositions.set(posKey, currentFails + 1);
            console.log(`[${this.name}] Block at ${posKey} failed ${currentFails + 1} times (local: ${this.retries}, underwater: ${underwaterRetries})`);

            await this.wander();
        }
    }

    // Compte les objets de l'inventaire qui valident l'objectif de minage.
    // Les minerais lâchent un objet de nom DIFFERENT du bloc (coal_ore -> coal,
    // diamond_ore -> diamond...). Sans ce mapping, le compteur reste a 0 et le bot
    // mine la veine a l'infini. C'est l'unique source de verite (run + staircase).
    countCollected() {
        // minerai (blockName) -> objet réellement lâché
        const oreDrops = {
            iron_ore: 'raw_iron',
            gold_ore: 'raw_gold',
            copper_ore: 'raw_copper',
            coal_ore: 'coal',
            diamond_ore: 'diamond',
            redstone_ore: 'redstone',
            lapis_ore: 'lapis_lazuli',
            emerald_ore: 'emerald',
        };

        return this.bot.inventory.items().reduce((total, i) => {
            // Exclure les outils
            if (i.name.includes('pickaxe') || i.name.includes('sword') ||
                i.name.includes('axe') || i.name.includes('shovel') || i.name.includes('hoe')) {
                return total;
            }

            const drop = oreDrops[this.blockName];
            if (drop) return total + (i.name === drop ? i.count : 0);

            if (this.blockName === 'stone') {
                const isStone = i.name === 'cobblestone' || i.name === 'cobbled_deepslate' ||
                    i.name === 'blackstone' || i.name === 'stone';
                return total + (isStone ? i.count : 0);
            }

            // Défaut : correspondance par nom (ex: oak_log)
            return total + (i.name.includes(this.blockName) ? i.count : 0);
        }, 0);
    }

    // Simple staircase mining - dig forward and down
    async mineStaircase() {
        console.log(`[${this.name}] Starting simple staircase mining`);

        try {
            // Dig 30 steps in a staircase pattern
            for (let i = 0; i < 30; i++) {
                // Check if we have enough
                const currentCount = this.countCollected();

                if (currentCount >= this.count) {
                    console.log(`[${this.name}] Found enough while mining!`);
                    return;
                }

                const pos = this.bot.entity.position.floored();

                // Dig block in front (head level)
                const frontHead = this.bot.blockAt(pos.offset(0, 1, 1));
                if (frontHead && frontHead.name !== 'air' && frontHead.name !== 'bedrock') {
                    if (frontHead.name.includes('lava')) break;
                    try {
                        await this.equipBestTool(frontHead);
                        await this.bot.dig(frontHead);
                    } catch (e) { }
                }

                // Dig block in front (feet level)  
                const frontFeet = this.bot.blockAt(pos.offset(0, 0, 1));
                if (frontFeet && frontFeet.name !== 'air' && frontFeet.name !== 'bedrock') {
                    if (frontFeet.name.includes('lava')) break;
                    try {
                        await this.equipBestTool(frontFeet);
                        await this.bot.dig(frontFeet);
                    } catch (e) { }
                }

                // Move forward
                this.bot.setControlState('forward', true);
                await this.bot.waitForTicks(8);
                this.bot.setControlState('forward', false);
            }
        } catch (e) {
            console.log(`[${this.name}] Staircase error: ${e.message}`);
        }
    }

    async safeDig(pos) {
        const block = this.bot.blockAt(pos);
        if (!block || block.type === 0) return;
        if (block.name === 'bedrock' || block.name.includes('lava')) return;

        await this.equipBestTool(block);
        try {
            await this.bot.dig(block);
        } catch (e) { }
    }

    async equipBestTool(block) {
        // Simple tool equip
        const pathfinder = this.bot.pathfinder;
        // We can use mineflayer-tool or manual
        // Manual check for pickaxe if stone
        if (this.blockName === 'stone' || this.blockName.includes('ore')) {
            const picks = this.bot.inventory.items().filter(i => i.name.includes('pickaxe'));
            if (picks.length > 0) {
                // Sort by Tier: Diamond > Iron > Stone > Wood
                const tierOrder = ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];

                picks.sort((a, b) => {
                    const tierA = tierOrder.indexOf(a.name);
                    const tierB = tierOrder.indexOf(b.name);
                    // If not found (e.g. netherite/gold), put at end (tier -1 -> huge index)
                    const valA = tierA === -1 ? 99 : tierA;
                    const valB = tierB === -1 ? 99 : tierB;
                    // Lower index = Better tool
                    return valA - valB;
                });

                const bestPick = picks[0];
                // Only log if changing tool or first equip
                const held = this.bot.heldItem;
                if (!held || held.name !== bestPick.name) {
                    console.log(`[${this.name}] Equipping best tool: ${bestPick.name}`);
                }

                await this.bot.equip(bestPick, 'hand');
            } else {
                console.log(`[${this.name}] CRITICAL: Trying to mine stone/ore but NO PICKAXE! Aborting.`);
                this.fail("No pickaxe for stone mining");
                throw new Error("No pickaxe");
            }
        }
    }

    async wander() {
        // High Ground Wander Strategy
        console.log(`[${this.name}] Searching for HIGH GROUND...`);
        const p = this.bot.entity.position;
        const { goals } = require('mineflayer-pathfinder');

        // Find a spot that is higher than current pos
        const highSpot = this.bot.findBlock({
            matching: [this.mcData.blocksByName.grass_block.id, this.mcData.blocksByName.dirt.id, this.mcData.blocksByName.stone.id],
            maxDistance: 32,
            useExtraInfo: (block) => block.position.y > p.y + 2 // Look for something at least 2 blocks higher
        });

        if (highSpot) {
            console.log(`[${this.name}] High ground found at ${highSpot.position}. Moving up.`);
            try {
                this.bot.pathfinder.setGoal(new goals.GoalNear(highSpot.position.x, highSpot.position.y + 1, highSpot.position.z, 1));
                await this.bot.waitForTicks(100);
            } catch (e) { }
        } else {
            // Random wander if no high ground
            console.log(`[${this.name}] No visible high ground. Wandering randomly.`);
            const x = p.x + (Math.random() * 20 - 10);
            const z = p.z + (Math.random() * 20 - 10);
            try {
                this.bot.pathfinder.setGoal(new goals.GoalNear(x, p.y, z, 1));
                await this.bot.waitForTicks(60);
            } catch (e) { }
        }
    }
}

module.exports = MineBlock;
