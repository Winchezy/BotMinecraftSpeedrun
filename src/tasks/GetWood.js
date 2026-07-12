const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

class GetWood extends Task {
    constructor(bot, targetCount = 5) {
        super(bot);
        this.name = 'GetWood';
        this.targetCount = targetCount;
        this.mcData = require('minecraft-data')(bot.version);
        this.blacklistedPositions = new Set(); // Track problematic positions
    }

    async run() {
        const logs = this.countLogs();
        if (logs >= this.targetCount) {
            this.complete();
            return;
        }

        console.log(`[${this.name}] Have ${logs}/${this.targetCount} logs.`);

        // Find nearest log that's NOT surrounded by water
        const logBlocks = this.bot.findBlocks({
            matching: (block) => block.name.includes('log') && !block.name.includes('stripped'),
            maxDistance: 64,
            count: 30
        });

        // Find the LOWEST log (tree base) to mine from ground
        let targetLog = null;
        for (const pos of logBlocks) {
            const posKey = `${pos.x},${pos.y},${pos.z}`;
            if (this.blacklistedPositions.has(posKey)) continue;

            const log = this.bot.blockAt(pos);
            if (!log) continue;

            // Check if this is a base log (solid block below, or low Y)
            const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));
            const isBase = blockBelow && (blockBelow.name === 'grass_block' || blockBelow.name === 'dirt' || blockBelow.name === 'stone' || pos.y < this.bot.entity.position.y + 3);

            if (isBase) {
                targetLog = log;
                break;
            }
        }

        if (!targetLog) {
            // Fall back to LOWEST available log
            let lowestY = 999;
            for (const pos of logBlocks) {
                const posKey = `${pos.x},${pos.y},${pos.z}`;
                if (this.blacklistedPositions.has(posKey)) continue;

                if (pos.y < lowestY) {
                    lowestY = pos.y;
                    targetLog = this.bot.blockAt(pos);
                }
            }

            if (!targetLog) {
                console.log(`[${this.name}] No accessible trees found. Wandering...`);
                // Clear blacklist after wandering
                this.blacklistedPositions.clear();
                await this.wander();
                return;
            }
        }

        const targetPosKey = `${targetLog.position.x},${targetLog.position.y},${targetLog.position.z}`;
        console.log(`[${this.name}] Target: ${targetLog.name} at ${targetLog.position}`);

        const logsBefore = this.countLogs();
        try {
            // Use timeout to prevent hanging
            const collectPromise = this.bot.collectBlock.collect(targetLog);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 15000)
            );

            await Promise.race([collectPromise, timeoutPromise]);

            // collectBlock peut se terminer SANS erreur alors que rien n'a ete mine
            // (bot jamais arrive a l'arbre : pathfinder interrompu par Survival, arbre
            // inaccessible...). On verifie donc que le nombre de logs a reellement augmente.
            if (this.countLogs() > logsBefore) {
                console.log(`[${this.name}] Collect finished.`);
                // Remove from blacklist if successful
                this.blacklistedPositions.delete(targetPosKey);
            } else {
                console.log(`[${this.name}] Aucun log gagne -> arbre inaccessible, blacklist ${targetPosKey}`);
                this.blacklistedPositions.add(targetPosKey);
                await this.stuckHandler();
            }
        } catch (err) {
            console.log(`[${this.name}] Collect error: ${err.message}`);
            // Blacklist this position
            this.blacklistedPositions.add(targetPosKey);
            console.log(`[${this.name}] Blacklisted position ${targetPosKey}`);
            await this.stuckHandler();
        }
    }

    // Check if a log position is accessible without going through water
    isAccessible(pos) {
        // Check the ground level around the log
        const offsets = [
            { x: 1, z: 0 }, { x: -1, z: 0 },
            { x: 0, z: 1 }, { x: 0, z: -1 }
        ];

        let safeAccess = 0;
        for (const off of offsets) {
            const checkPos = pos.offset(off.x, 0, off.z);
            const block = this.bot.blockAt(checkPos);
            const blockBelow = this.bot.blockAt(checkPos.offset(0, -1, 0));

            // Check if this side is not water
            if (block && !block.name.includes('water') &&
                blockBelow && !blockBelow.name.includes('water')) {
                safeAccess++;
            }
        }

        // Need at least 2 safe sides
        return safeAccess >= 2;
    }

    countLogs() {
        return this.bot.inventory.items()
            .filter(i => i.name.includes('log'))
            .reduce((acc, i) => acc + i.count, 0);
    }

    async wander() {
        const p = this.bot.entity.position;
        // Wander far to find a better area (away from water/jungle)
        const angle = Math.random() * Math.PI * 2;
        const distance = 50 + Math.random() * 50; // 50-100 blocks away
        const x = p.x + Math.cos(angle) * distance;
        const z = p.z + Math.sin(angle) * distance;

        console.log(`[${this.name}] Wandering to (${x.toFixed(0)}, ${z.toFixed(0)})...`);
        this.bot.pathfinder.setGoal(new goals.GoalNear(x, p.y, z, 5));
        await this.bot.waitForTicks(100); // Wait longer for longer journey
    }

    async stuckHandler() {
        console.log("Checking if stuck in leaves/foliage...");
        const pos = this.bot.entity.position.floored();
        const targets = [
            this.bot.blockAt(pos),
            this.bot.blockAt(pos.offset(0, 1, 0))
        ].filter(b => b && (b.name.includes('leaves') || b.name.includes('vine') || b.name.includes('grass')));

        for (const t of targets) {
            try {
                await this.bot.dig(t);
            } catch (e) {
                // Ignore dig errors
            }
        }

        // Also wait a bit to let pathfinder reset
        await this.bot.waitForTicks(20);
    }
}

module.exports = GetWood;
