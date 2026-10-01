const Task = require('../lib/Task');

// Cerveau neuronal partagé pour les décisions de remontée
let movementBrain = null;
try {
    const { getInstance } = require('../lib/MovementBrain');
    movementBrain = getInstance();
} catch (e) { /* Pas de cerveau, on utilise les règles */ }

class MoveToSurface extends Task {
    constructor(bot) {
        super(bot);
        this.name    = 'MoveToSurface';
        this.mcData  = require('minecraft-data')(bot.version);
        this.attempts = 0;
        this.startY  = bot.entity ? bot.entity.position.y : null;
        this._digFailures  = 0;   // échecs consécutifs de dig
        this._lastDigBlock = null; // clé du dernier bloc tenté
    }

    async run() {
        this.attempts++;

        // Increase failure limit to 150
        if (this.attempts > 150) {
            console.log('[MoveToSurface] Max attempts reached, completing task');
            this.complete();
            return;
        }

        const pos = this.bot.entity.position;

        // Y > 62 suffit — pas de dépendance skyLight (faux négatifs la nuit / zones couvertes)
        if (pos.y > 62) {
            console.log(`[MoveToSurface] Reached surface! (Y: ${pos.y.toFixed(1)})`);
            if (movementBrain) movementBrain.saveAll();
            this.complete();
            return;
        }

        console.log(`[MoveToSurface] Current Y: ${pos.y.toFixed(0)} | Attempt ${this.attempts}`);

        // Check for stuck (simple Y check)
        if (this.lastY === undefined || Math.abs(pos.y - this.lastY) > 0.5) {
            this.stuckCount = 0;
            this.lastY = pos.y;
        } else {
            this.stuckCount = (this.stuckCount || 0) + 1;
        }

        if (this.stuckCount > 20) {
            console.log("[MoveToSurface] STUCK at same Y for too long. Moving randomly.");
            const _yBeforeStuck = pos.y;
            await this.doStaircaseUp(pos);
            if (movementBrain) movementBrain.recordSurfaceSuccess(this.bot, 'STAIRCASE_UP', this.stuckCount, this.startY, _yBeforeStuck);
            this.stuckCount = 0;
            return;
        }

        // ── Sélection de stratégie (neuronale ou règles) ──────────────────────
        const placeableItems = this.bot.inventory.items().filter(i =>
            i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
            i.name === 'netherrack' || i.name === 'andesite' || i.name === 'diorite' ||
            i.name === 'granite' || i.name.includes('planks') || i.name.includes('log')
        );

        // Décision neuronale
        if (movementBrain) {
            const neuralDecision = movementBrain.decideSurfaceAction(
                this.bot, this.stuckCount ?? 0, this.startY
            );
            if (neuralDecision) {
                const { action } = neuralDecision;
                if (action === 'PILLAR_UP' && placeableItems.length > 0) {
                    await this.doPillarUp(placeableItems[0]);
                    return;
                } else if (action === 'DIG_CEILING') {
                    const blockAboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
                    if (blockAboveHead && blockAboveHead.boundingBox === 'block') {
                        await this.equipBestTool(blockAboveHead);
                        await this.bot.dig(blockAboveHead);
                        return;
                    }
                } else if (action === 'STAIRCASE_UP' || action === 'DIG_FORWARD') {
                    await this.doStaircaseUp(pos);
                    return;
                } else if (action === 'STOP') {
                    this.complete();
                    return;
                }
                // Action non applicable → règles prennent la relève
            }
        }

        // Règles de fallback + enregistrement reward-based
        const _yBeforeFallback = pos.y;
        const blockAboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
        const ceilingBlocked = !!(blockAboveHead && blockAboveHead.boundingBox === 'block');

        // Si le même bloc de plafond échoue 3 fois de suite → forcer staircase
        const ceilKey = blockAboveHead ? `${blockAboveHead.position.x},${blockAboveHead.position.y},${blockAboveHead.position.z}` : null;
        if (ceilKey && ceilKey === this._lastDigBlock) {
            this._digFailures++;
        } else {
            this._digFailures = 0;
            this._lastDigBlock = ceilKey;
        }
        const forceStaircase = this._digFailures >= 3;

        if (!forceStaircase && placeableItems.length > 0) {
            if (ceilingBlocked) {
                await this.doPillarUp(placeableItems[0]); // va creuser le plafond
                if (movementBrain) movementBrain.recordSurfaceSuccess(this.bot, 'DIG_CEILING', this.stuckCount ?? 0, this.startY, _yBeforeFallback);
            } else {
                await this.doPillarUp(placeableItems[0]); // va pillar
                if (movementBrain) movementBrain.recordSurfaceSuccess(this.bot, 'PILLAR_UP', this.stuckCount ?? 0, this.startY, _yBeforeFallback);
            }
        } else {
            if (forceStaircase) {
                console.log(`[MoveToSurface] Dig sur même bloc échoué ${this._digFailures}x → forcé STAIRCASE`);
                this._digFailures = 0;
                this._lastDigBlock = null;
            }
            if (ceilingBlocked) {
                await this.doStaircaseUp(pos);
                if (movementBrain) movementBrain.recordSurfaceSuccess(this.bot, 'DIG_FORWARD', this.stuckCount ?? 0, this.startY, _yBeforeFallback);
            } else {
                await this.doStaircaseUp(pos);
                if (movementBrain) movementBrain.recordSurfaceSuccess(this.bot, 'STAIRCASE_UP', this.stuckCount ?? 0, this.startY, _yBeforeFallback);
            }
        }
    }

    async doPillarUp(blockItem) {
        const pos = this.bot.entity.position;
        // 1. Ensure Ceiling is Clear
        // Check Y+2 (Directly above head)
        const blockAboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
        if (blockAboveHead && blockAboveHead.boundingBox === 'block') {
            console.log(`[MoveToSurface] Pillar: Clearing ceiling ${blockAboveHead.name}`);
            await this.equipBestTool(blockAboveHead);
            await this.bot.dig(blockAboveHead);
            return; // Wait for tick
        }

        // 2. Perform Pillar Jump
        try {
            await this.bot.equip(blockItem, 'hand');

            // Look down completely
            await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);

            // Jump and Place
            this.bot.setControlState('jump', true);

            // Wait slightly for liftoff
            await this.bot.waitForTicks(2);

            // We place against the block UNDER us (0, -1, 0) on face (0, 1, 0)
            const refBlock = this.bot.blockAt(pos.offset(0, -1, 0));
            if (refBlock) {
                const Vec3 = require('vec3').Vec3;
                await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                console.log(`[MoveToSurface] Pillared up with ${blockItem.name}`);
            }

            // Stabilize
            await this.bot.waitForTicks(2);
            this.bot.setControlState('jump', false);
        } catch (err) {
            console.log(`[MoveToSurface] Pillar error: ${err.message}`);
            this.bot.setControlState('jump', false);
        }
    }

    async doStaircaseUp(pos) {
        const { Vec3 } = require('vec3');
        // Get view vector (snap to 90 degrees)
        const lookDir = this.bot.entity.yaw;
        const cardInputs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
        let bestYaw = cardInputs[0];
        let minDiff = 100;
        for (const y of cardInputs) {
            let diff = Math.abs(y - lookDir);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;
            if (diff < minDiff) { minDiff = diff; bestYaw = y; }
        }

        // Force look at cardinal
        await this.bot.look(bestYaw, 0);

        // Calculate forward vector
        const forward = new Vec3(-Math.sin(bestYaw), 0, -Math.cos(bestYaw)).floor();
        const targetPos = pos.plus(forward);
        const targetBlockHead = this.bot.blockAt(targetPos.offset(0, 1, 0));
        const targetBlockAbove = this.bot.blockAt(targetPos.offset(0, 2, 0));

        // Dig blocks to make stairs
        let dug = false;

        // Ensure ceiling above is clear too for jumping
        const currentCeiling = this.bot.blockAt(pos.offset(0, 2, 0));
        if (currentCeiling && currentCeiling.boundingBox === 'block') {
            await this.equipBestTool(currentCeiling);
            await this.bot.dig(currentCeiling);
            dug = true;
        }

        if (targetBlockHead && targetBlockHead.boundingBox === 'block') {
            await this.equipBestTool(targetBlockHead);
            await this.bot.dig(targetBlockHead);
            dug = true;
        }
        if (targetBlockAbove && targetBlockAbove.boundingBox === 'block') {
            await this.equipBestTool(targetBlockAbove);
            await this.bot.dig(targetBlockAbove);
            dug = true;
        }

        if (dug) return; // If we dug, wait for next tick to move

        // Check if there is something to walk on
        const floor = this.bot.blockAt(targetPos);
        if (!floor || floor.boundingBox !== 'block') {
            // Gap! Bridge it.
            const placeable = this.bot.inventory.items().find(i =>
                i.name.includes('dirt') || i.name.includes('stone') || i.name.includes('cobble') ||
                i.name.includes('planks') || i.name.includes('rack') || i.name.includes('granite')
            );
            if (placeable) {
                const support = this.bot.blockAt(targetPos.offset(0, -1, 0));
                if (support && support.boundingBox === 'block') {
                    await this.bot.equip(placeable, 'hand');
                    await this.bot.placeBlock(support, new Vec3(0, 1, 0));
                    await this.bot.waitForTicks(5);
                    return;
                }
            }
        }

        // Should be clear to move/jump
        try {
            this.bot.setControlState('sprint', true);
            this.bot.setControlState('jump', true);
            this.bot.setControlState('forward', true);
            await this.bot.waitForTicks(15);
        } finally {
            this.bot.setControlState('jump', false);
            this.bot.setControlState('forward', false);
            this.bot.setControlState('sprint', false);
        }
    }

    async equipBestTool(block) {
        const item = this.bot.pathfinder.bestHarvestTool(block);
        if (item) {
            await this.bot.equip(item, 'hand');
        } else {
            // If block requires tool (like stone) and we have none, we are slow mining.
            // Check if we have ANY pickaxe.
            const pickaxe = this.bot.inventory.items().find(i => i.name.includes('pickaxe'));
            if (pickaxe) {
                await this.bot.equip(pickaxe, 'hand');
            } else {
                // Check if material requires tool
                // block.material is essentially the type.
                // checking `harvestTools` map from mcData might be complex here.
                // Simple check: Stone/Rock/Metal requires pickaxe.
                // If we have NO pickaxe, and we mine stone, it takes forever.
                const name = block.name;
                if (name.includes('stone') || name.includes('ore') || name.includes('deepslate') || name.includes('granite') || name.includes('diorite') || name.includes('andesite')) {
                    console.log("[MoveToSurface] No pickaxe to mine " + block.name + "! Aborting to craft one.");
                    this.fail("No Pickaxe");
                    throw new Error("No Pickaxe");
                }
            }
        }
    }

    async pillarUp() {
        const { Vec3 } = require('vec3');
        const pos = this.bot.entity.position.floored();

        // Get placeable blocks
        const placeableItems = this.bot.inventory.items().filter(i =>
            i.name === 'dirt' ||
            i.name === 'cobblestone' ||
            i.name.includes('planks') ||
            i.name.includes('log')
        );

        if (placeableItems.length === 0) {
            console.log('[MoveToSurface] No blocks to pillar with');
            return;
        }

        try {
            const item = placeableItems[0];
            await this.bot.equip(item, 'hand');

            // Look down
            await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
            await this.bot.waitForTicks(2);

            this.bot.setControlState('jump', true);
            // Wait for peak of jump
            await this.bot.waitForTicks(5);

            // Try to place block under feet
            // We target the block we are jumping FROM (y-1) and place on its top face (0,1,0)
            const refBlock = this.bot.blockAt(pos.offset(0, -1, 0));

            if (refBlock) {
                await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                console.log('[MoveToSurface] Pillared up!');
            }

            this.bot.setControlState('jump', false);
            await this.bot.waitForTicks(5); // Stabilize
        } catch (e) {
            console.log(`[MoveToSurface] Pillar error: ${e.message}`);
            // Often fails if we are not exactly aligned or timing is off, just ignore and retry
            this.bot.setControlState('jump', false);
        }
    }

    // findPathUp removed/unused in favor of pillaring
    async findPathUp() {
    }
}

module.exports = MoveToSurface;
