const Task       = require('../lib/Task');
const { goals }  = require('mineflayer-pathfinder');
const WoodBrain  = require('../lib/WoodBrain');

class GetWood extends Task {
    constructor(bot, targetCount = 5) {
        super(bot);
        this.name        = 'GetWood';
        this.targetCount = targetCount;
        this.mcData      = require('minecraft-data')(bot.version);
        this.blacklistedPositions = new Set();
    }

    async run() {
        const logs = this.countLogs();
        if (logs >= this.targetCount) {
            this.complete();
            return;
        }

        console.log(`[${this.name}] Have ${logs}/${this.targetCount} logs.`);

        // Analyser l'environnement
        const allLogs = this._findAllNearbyLogs();
        if (allLogs.length === 0) {
            console.log(`[${this.name}] No trees found. Wandering...`);
            this.blacklistedPositions.clear();
            this.blacklistedTrees = new Set();
            await this._wander();
            return;
        }

        const treeInfo   = this._analyzeTree(allLogs);
        const brain      = WoodBrain.getInstance();
        const decision   = brain.decide(this.bot, treeInfo);
        const action     = decision ? decision.action : WoodBrain.ruleDecide(treeInfo);
        const logsBefore = this.countLogs();

        console.log(`[${this.name}] Action: ${action} | botYInTree: ${treeInfo.botYInTree.toFixed(2)} | logsBelow: ${treeInfo.logsBelow}`);

        try {
            switch (action) {
                case 'MINE_BELOW':
                    await this._mineBelow(treeInfo);
                    break;
                case 'MINE_BASE':
                    await this._mineBase(treeInfo);
                    break;
                case 'MINE_NEAREST':
                default:
                    await this._mineNearest(treeInfo.allLogs);
                    break;
            }
        } catch (err) {
            console.log(`[${this.name}] Error during ${action}: ${err.message}`);
            await this._stuckHandler();
        }

        // Enregistrer uniquement si l'action a réussi
        if (this.countLogs() > logsBefore) {
            brain.recordSuccess(this.bot, treeInfo, action);
        }
    }

    // ── Analyse de l'arbre ─────────────────────────────────────────────────────

    _findAllNearbyLogs() {
        const positions = this.bot.findBlocks({
            matching: (block) => block.name.includes('log') && !block.name.includes('stripped'),
            maxDistance: 64,
            count: 50
        });

        return positions
            .map(pos => this.bot.blockAt(pos))
            .filter(b => b && !this.blacklistedPositions.has(`${b.position.x},${b.position.y},${b.position.z}`));
    }

    _analyzeTree(allLogs) {
        const botPos    = this.bot.entity.position;
        const botY      = botPos.y;

        const logsAbove = allLogs.filter(b => b.position.y > botY).length;
        const logsBelow = allLogs.filter(b => b.position.y < botY).length;
        const logsTotal = allLogs.length;

        // Log le plus bas (base du tronc)
        const lowestLog = allLogs.reduce((min, b) => b.position.y < min.position.y ? b : min, allLogs[0]);
        const highestLog = allLogs.reduce((max, b) => b.position.y > max.position.y ? b : max, allLogs[0]);

        const treeBaseY = lowestLog.position.y;
        const treeTopY  = highestLog.position.y;
        const treeHeight = Math.max(1, treeTopY - treeBaseY);
        const botYInTree = (botY - treeBaseY) / treeHeight;

        // Log le plus bas accessible en dessous du bot (portée ~4.5 blocs)
        const logsUnderBot = allLogs
            .filter(b => b.position.y < botY)
            .sort((a, b) => b.position.y - a.position.y); // du plus proche vers le plus bas

        let nearestBelowLog   = null;
        let nearestBelowDY    = 0;
        let nearestBelowDXZ   = 999;
        let hasLogWithinReachBelow = false;

        if (logsUnderBot.length > 0) {
            nearestBelowLog = logsUnderBot[0];
            const dx = nearestBelowLog.position.x - botPos.x;
            const dz = nearestBelowLog.position.z - botPos.z;
            nearestBelowDY  = nearestBelowLog.position.y - botY; // négatif
            nearestBelowDXZ = Math.sqrt(dx * dx + dz * dz);
            const dist3d = botPos.distanceTo(nearestBelowLog.position);
            hasLogWithinReachBelow = dist3d < 4.5 && nearestBelowDXZ < 3;
        }

        const distToLowestLog = botPos.distanceTo(lowestLog.position);

        return {
            allLogs, lowestLog, highestLog,
            logsAbove, logsBelow, logsTotal,
            botYInTree, treeBaseY, treeTopY, treeHeight,
            nearestBelowLog, nearestBelowDY, nearestBelowDXZ,
            hasLogWithinReachBelow, distToLowestLog
        };
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    // Miner le log le plus haut accessible en dessous du bot
    async _mineBelow(treeInfo) {
        const { nearestBelowLog } = treeInfo;
        if (!nearestBelowLog) {
            console.log(`[${this.name}] No log below — falling back to nearest`);
            await this._mineNearest(treeInfo.allLogs || []);
            return;
        }

        console.log(`[${this.name}] Mining below at y=${nearestBelowLog.position.y}`);
        const key = `${nearestBelowLog.position.x},${nearestBelowLog.position.y},${nearestBelowLog.position.z}`;
        const logsBefore = this.countLogs();
        const pos = nearestBelowLog.position;

        try {
            // Se positionner sur le dessus du log pour tomber avec le drop
            const dist = this.bot.entity.position.distanceTo(pos);
            console.log(`[${this.name}] Navigating to log at dist=${dist.toFixed(1)}`);
            await Promise.race([
                this.bot.pathfinder.goto(new goals.GoalBlock(pos.x, pos.y + 1, pos.z)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), 5000))
            ]);
        } catch(e) {
            console.log(`[${this.name}] Nav to log: ${e.message} — trying from current pos`);
        }

        try {
            const block = this.bot.blockAt(pos);
            if (block && block.name.includes('log')) {
                await this.bot.dig(block);
                // Le bot tombe sur le log suivant — le drop est à ses pieds
                await this.bot.waitForTicks(25);
            }
        } catch (e) {
            console.log(`[${this.name}] dig failed: ${e.message}`);
        }

        const logsAfter = this.countLogs();
        if (logsAfter > logsBefore) {
            console.log(`[${this.name}] Collected! ${logsBefore} → ${logsAfter} logs.`);
            this.blacklistedPositions.delete(key);
        } else {
            console.log(`[${this.name}] No log gained. Blacklisting ${key}.`);
            this.blacklistedPositions.add(key);
        }
    }

    // Aller à la base de l'arbre et miner de bas en haut
    async _mineBase(treeInfo) {
        await this._clearNearbyLeaves();
        const { lowestLog } = treeInfo;
        console.log(`[${this.name}] Going to tree base y=${lowestLog.position.y}`);
        const key = `${lowestLog.position.x},${lowestLog.position.y},${lowestLog.position.z}`;
        const logsBefore = this.countLogs();

        try {
            await Promise.race([
                this.bot.collectBlock.collect(lowestLog),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
            ]);
            await this.bot.waitForTicks(10);
        } catch (e) {
            try {
                // Naviguer vers la base d'abord (avec timeout pour éviter le blocage)
                await Promise.race([
                    this.bot.pathfinder.goto(
                        new goals.GoalNear(lowestLog.position.x, lowestLog.position.y, lowestLog.position.z, 2)
                    ),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), 10000))
                ]);
                const block = this.bot.blockAt(lowestLog.position);
                if (block && block.name.includes('log')) {
                    await this.bot.dig(block);
                    await this.bot.waitForTicks(25);
                    // Ramasser le drop (le log tombe à nos pieds)
                    try {
                        await this.bot.pathfinder.goto(
                            new goals.GoalNear(lowestLog.position.x, lowestLog.position.y, lowestLog.position.z, 1)
                        );
                    } catch (_) {}
                    await this.bot.waitForTicks(15);
                }
            } catch (e2) {
                console.log(`[${this.name}] Path to base failed: ${e2.message}`);
                this.blacklistedPositions.add(key);
                this._blacklistTree(`${lowestLog.position.x},${lowestLog.position.z}`);
            }
        }

        const logsAfter = this.countLogs();
        if (logsAfter > logsBefore) {
            console.log(`[${this.name}] Collected from base! ${logsBefore} → ${logsAfter} logs.`);
        } else {
            this.blacklistedPositions.add(key);
        }
    }

    // Blackliste tous les logs appartenant au même arbre (même colonne XZ)
    _blacklistTree(xz) {
        this.blacklistedTrees = this.blacklistedTrees || new Set();
        this.blacklistedTrees.add(xz);
    }
    _isTreeBlacklisted(log) {
        this.blacklistedTrees = this.blacklistedTrees || new Set();
        return this.blacklistedTrees.has(`${log.position.x},${log.position.z}`);
    }

    // Miner le log le plus proche (fallback)
    async _mineNearest(allLogs) {
        await this._clearNearbyLeaves();
        if (!allLogs || allLogs.length === 0) {
            console.log(`[${this.name}] No logs for mineNearest. Wandering...`);
            await this._wander();
            return;
        }

        const botPos = this.bot.entity.position;
        const sorted = allLogs.slice().sort((a, b) =>
            botPos.distanceTo(a.position) - botPos.distanceTo(b.position)
        );

        for (const log of sorted) {
            const key = `${log.position.x},${log.position.y},${log.position.z}`;
            if (this.blacklistedPositions.has(key)) continue;
            if (this._isTreeBlacklisted(log)) continue;

            const logsBefore = this.countLogs();
            console.log(`[${this.name}] Mining nearest: ${log.name} at ${log.position}`);

            try {
                await Promise.race([
                    this.bot.collectBlock.collect(log),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                ]);
                await this.bot.waitForTicks(10);
            } catch (e) {
                try {
                    if (botPos.distanceTo(log.position) > 3) {
                        await Promise.race([
                            this.bot.pathfinder.goto(
                                new goals.GoalNear(log.position.x, log.position.y, log.position.z, 2)
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), 6000))
                        ]);
                    }
                    const block = this.bot.blockAt(log.position);
                    if (block && block.name.includes('log')) {
                        await this.bot.dig(block);
                        await this.bot.waitForTicks(25);
                    }
                } catch (e2) {
                    // Blacklister tout l'arbre (même XZ) pour ne pas réessayer log par log
                    this._blacklistTree(`${log.position.x},${log.position.z}`);
                    console.log(`[${this.name}] Arbre inaccessible à (${log.position.x}, ${log.position.z}) — blacklist complète`);
                    continue;
                }
            }

            const logsAfter = this.countLogs();
            if (logsAfter > logsBefore) {
                console.log(`[${this.name}] Collected! ${logsBefore} → ${logsAfter} logs.`);
                return;
            } else {
                this.blacklistedPositions.add(key);
            }
        }

        console.log(`[${this.name}] All logs failed. Wandering...`);
        this.blacklistedPositions.clear();
        await this._wander();
    }

    // ── Utilitaires ────────────────────────────────────────────────────────────

    // Casse les feuilles/vignes immédiatement autour du bot (corps + tête + devant)
    async _clearNearbyLeaves() {
        const pos = this.bot.entity.position.floored();
        const yaw = this.bot.entity.yaw;
        const fdx = -Math.round(Math.sin(yaw));
        const fdz = -Math.round(Math.cos(yaw));

        const toCheck = [
            pos.offset(0, 1, 0),
            pos.offset(0, 2, 0),
            pos.offset(fdx, 0, fdz),
            pos.offset(fdx, 1, fdz),
            pos.offset(fdx, 2, fdz),
        ];

        const breakable = ['leaves', 'vine', 'grass', 'fern', 'bush'];
        for (const p of toCheck) {
            const b = this.bot.blockAt(p);
            if (b && breakable.some(k => b.name.includes(k))) {
                try { await this.bot.dig(b); } catch (_) {}
            }
        }
    }

    countLogs() {
        return this.bot.inventory.items()
            .filter(i => i.name.includes('log') && !i.name.includes('stripped'))
            .reduce((acc, i) => acc + i.count, 0);
    }

    async _wander() {
        const p      = this.bot.entity.position;
        const angle  = Math.random() * Math.PI * 2;
        const dist   = 50 + Math.random() * 50;
        const x      = p.x + Math.cos(angle) * dist;
        const z      = p.z + Math.sin(angle) * dist;
        console.log(`[${this.name}] Wandering to (${x.toFixed(0)}, ${z.toFixed(0)})...`);
        this.bot.pathfinder.setGoal(new goals.GoalNear(x, p.y, z, 5));
        await this.bot.waitForTicks(100);
    }

    async _stuckHandler() {
        const pos = this.bot.entity.position.floored();
        const yaw = this.bot.entity.yaw;
        const fdx = -Math.round(Math.sin(yaw));
        const fdz = -Math.round(Math.cos(yaw));

        // Positions à vérifier : autour du bot + direction regardée
        const toCheck = [
            pos,
            pos.offset(0, 1, 0),
            pos.offset(0, 2, 0),
            pos.offset(fdx, 0, fdz),
            pos.offset(fdx, 1, fdz),
            pos.offset(fdx, 2, fdz),
            // Les 4 directions cardinales au niveau tête
            pos.offset(1, 1, 0), pos.offset(-1, 1, 0),
            pos.offset(0, 1, 1), pos.offset(0, 1, -1),
        ];

        const breakable = ['leaves', 'vine', 'grass', 'fern', 'bush'];
        const targets = toCheck
            .map(p => this.bot.blockAt(p))
            .filter(b => b && breakable.some(k => b.name.includes(k)));

        for (const t of targets) {
            try { await this.bot.dig(t); } catch (_) {}
        }

        await this.bot.waitForTicks(20);
    }
}

module.exports = GetWood;
