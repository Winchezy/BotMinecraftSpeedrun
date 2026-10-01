const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { isAtSurface } = require('../lib/Trail');
const MoveToSurface = require('./MoveToSurface');
const { existingPassageMovements, planCompletePath, withTimeout } = require('../lib/Pathing');
const { threatNearPoint, threatNearPath } = require('../lib/MobSafety');

class GetWood extends Task {
    constructor(bot, targetCount = 5) {
        super(bot);
        this.name = 'GetWood';
        this.targetCount = targetCount;
        this.mcData = require('minecraft-data')(bot.version);
        this.blacklistedPositions = new Set(); // Track problematic positions
    }

    async run() {
        if (this.bot.isInCombat?.()) return;
        if (this.bot.entity?.onGround === false) return;
        this.treeEscape ||= new (require('../lib/TreeEscape'))(this.bot);
        if (this.treeEscape.onTree() && this.bot.canDigBlock) {
            if (!this.treeNotice) {
                this.treeNotice = true;
                this.bot.chat?.('[SpeedBot] Je suis sur un arbre : descente prudente avant de poursuivre.');
            }
            if (await this.treeEscape.run()) return;
            // Pas de trajet aleatoire a la hauteur des cimes si la descente echoue.
            console.log('[GetWood] Descente de l arbre sans passage sur pour le moment.');
            return;
        }
        const logs = this.countLogs();
        if (logs >= this.targetCount) {
            this.complete();
            return;
        }
        const nearbyLogs = this.bot.findBlocks({
            matching: block => block.name.endsWith('_log') && !block.name.startsWith('stripped_'),
            maxDistance: 32, count: 30
        });
        const targetLog = await this.findReachableLog(nearbyLogs);
        if (this.bot.isInCombat?.()) return;
        if (!targetLog && !isAtSurface(this.bot)) {
            this.surfaceTask ||= new MoveToSurface(this.bot);
            await this.surfaceTask.run();
            if (this.surfaceTask.hasFailed) this.fail(this.surfaceTask.failureReason);
            return;
        }

        console.log(`[${this.name}] Have ${logs}/${this.targetCount} logs.`);

        if (!targetLog) {
                console.log(`[${this.name}] No accessible trees found. Wandering...`);
                // Clear blacklist after wandering
                this.blacklistedPositions.clear();
                await this.wander();
                return;
        }

        const targetPosKey = `${targetLog.position.x},${targetLog.position.y},${targetLog.position.z}`;
        console.log(`[${this.name}] Target: ${targetLog.name} at ${targetLog.position}`);

        const logsBefore = this.countLogs();
        try {
            // Use timeout to prevent hanging
            const collectPromise = this.bot.collectBlock.collect(targetLog);
            await withTimeout(this.bot, collectPromise, 15000, 'Collecte de bois bloquee');

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
            // Le timeout doit vraiment arreter le plugin avant le prochain arbre.
            if (this.bot.collectBlock.cancelTask) {
                try { await withTimeout(this.bot, this.bot.collectBlock.cancelTask(), 2000, 'Annulation collecte'); }
                catch (_) { }
            }
            if (this.bot.isInCombat?.()) return;
            console.log(`[${this.name}] Collect error: ${err.message}`);
            // Blacklist this position
            this.blacklistedPositions.add(targetPosKey);
            console.log(`[${this.name}] Blacklisted position ${targetPosKey}`);
            await this.stuckHandler();
        }
    }

    async findReachableLog(positions) {
        const bot = this.bot;
        const feet = bot.entity.position.floored();
        const walking = existingPassageMovements(bot);
        positions.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
        for (const pos of positions.slice(0, 12)) {
            if (this.blacklistedPositions.has(`${pos.x},${pos.y},${pos.z}`) ||
                (pos.x === feet.x && pos.z === feet.z && pos.y < feet.y) ||
                !this.isAccessible(pos) || threatNearPoint(bot, pos, 2)) continue;
            const goal = new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 });
            const route = await planCompletePath(bot, goal, 500, walking);
            if (bot.isInCombat?.()) return null;
            if (route.status === 'success' && !threatNearPath(bot, route.path)) return bot.blockAt(pos);
        }
        return null;
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
