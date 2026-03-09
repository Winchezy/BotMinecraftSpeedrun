const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3').Vec3;

class DigDown extends Task {
    constructor(bot, targetY) {
        super(bot);
        this.name = 'DigDown';
        this.targetY = targetY;
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        const pos = this.bot.entity.position;
        if (pos.y <= this.targetY) {
            console.log(`[DigDown] Reached target Y: ${this.targetY}`);
            this.complete();
            return;
        }

        // Check for diamonds first
        const diamond = this.bot.findBlock({
            matching: [this.mcData.blocksByName.diamond_ore.id, this.mcData.blocksByName.deepslate_diamond_ore.id],
            maxDistance: 5
        });
        if (diamond) {
            console.log(`[DigDown] Found diamond at ${diamond.position}! Stopping to mine.`);
            this.complete();
            return;
        }

        // STAIRCASE STRATEGY
        // We dig blocks IN FRONT of us and DOWN, never directly under feet.
        // Pattern:
        // 1. Dig block in front at eyes (optional, to clear path) -> (0, 1, 1) relative
        // 2. Dig block in front at feet -> (0, 0, 1) relative
        // 3. Dig block in front and below -> (0, -1, 1) relative
        // 4. Walk forward.
        // Result: We descend 1 block for every 1 block forward.

        // Determine direction to face (snap to nearest cardial)
        // Or just maintain current yaw if it's aligned?
        // Let's snap to a cardinal direction to keep the staircase clean.

        // Current cardinal direction:
        const yaw = this.bot.entity.yaw;
        const cardinal = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);

        // Vector for forward
        const dx = -Math.sin(cardinal);
        const dz = -Math.cos(cardinal);
        const forward = new Vec3(Math.round(dx), 0, Math.round(dz));

        const botPos = this.bot.entity.position.floored();

        // Define targets relative to bot
        const targetHead = botPos.offset(forward.x, 1, forward.z);
        const targetBody = botPos.offset(forward.x, 0, forward.z);
        const targetFloor = botPos.offset(forward.x, -1, forward.z);
        const targetFloor2 = botPos.offset(forward.x, -2, forward.z); // Check for safety below target

        // Equip Pickaxe
        // Equip Pickaxe
        const pickaxe = this.bot.inventory.items().find(i => i.name.includes('pickaxe'));
        if (pickaxe) {
            await this.bot.equip(pickaxe, 'hand');
        } else {
            console.log("[DigDown] No pickaxe found! Cannot dig stone shaft safely.");
            this.fail("No pickaxe");
            return;
        }

        // Look at cardinal
        await this.bot.look(cardinal, 0);

        // 1. Clear Head (if needed)
        const blkHead = this.bot.blockAt(targetHead);
        if (blkHead && blkHead.boundingBox === 'block') {
            await this.bot.dig(blkHead);
            return;
        }

        // 1b. EXTRA CLEARANCE: Head+1 (Up) - Avoid head hitting ceiling
        const blkHeadUp = this.bot.blockAt(targetHead.offset(0, 1, 0));
        if (blkHeadUp && blkHeadUp.boundingBox === 'block') {
            await this.bot.dig(blkHeadUp);
            return;
        }

        // 2. Clear Body (Front)
        const blkBody = this.bot.blockAt(targetBody);
        if (blkBody && blkBody.boundingBox === 'block') {
            await this.bot.dig(blkBody);
            return;
        }

        // 2b. EXTRA CLEARANCE: Sides?
        // If we are stuck, maybe the hole is too narrow? 
        // Let's assume 1-wide is enough if aligned properly.
        // But let's check if we are colliding with something at our current pos.
        const currentPos = this.bot.entity.position;
        const currentHead = this.bot.blockAt(currentPos.offset(0, 1, 0).floored());
        if (currentHead && currentHead.boundingBox === 'block') {
            // We are inside a block?? Dig it.
            await this.bot.dig(currentHead);
            return;
        }

        // 3. Clear Floor (Front-Down)
        const blkFloor = this.bot.blockAt(targetFloor);
        if (blkFloor && blkFloor.boundingBox === 'block') {
            // Safety Check: What's below this target floor?
            // If we break targetFloor, we will eventually step into it.
            // So we need to know if targetFloor2 (Y-2) is solid.
            // Safety Check: What's below this target floor?
            // If we break targetFloor, we will eventually step into it.
            // So we need to know if targetFloor2 (Y-2) is solid.
            const blkBelowTarget = this.bot.blockAt(targetFloor2);

            // Check if void (Air) or Liquid
            if (!blkBelowTarget || blkBelowTarget.boundingBox !== 'block') {

                // 1. LIQUID -> STOP
                if (blkBelowTarget && (blkBelowTarget.name.includes('lava') || blkBelowTarget.name.includes('water'))) {
                    console.log("[DigDown] Liquid detected below path! Stopping staircase.");
                    this.complete();
                    return;
                }

                // 2. VOID (Air) -> TRY TO BRIDGE
                console.log("[DigDown] Void detected below path! Attempting to bridge...");

                const placeable = this.bot.inventory.items().find(i =>
                    i.name === 'cobblestone' || i.name === 'dirt' ||
                    i.name === 'stone' || i.name === 'netherrack' ||
                    i.name === 'andesite' || i.name === 'diorite' || i.name === 'granite' ||
                    i.name.includes('log') || i.name.includes('planks')
                );

                let bridged = false;
                if (placeable) {
                    try {
                        await this.bot.equip(placeable, 'hand');
                        // We need to place a block at targetFloor2.
                        // We can place it against targetFloor (from SIDE?) or wait, targetFloor is solid right now?
                        // Yes, targetFloor is SOLID. targetFloor2 is AIR.
                        // But we can't see targetFloor2 easily if targetFloor is blocking it.
                        // Actually, we are standing at `botPos`. `targetFloor` is (forward, -1).
                        // We haven't dug `targetFloor` yet. So `blkFloor` exists.
                        // So we can't place at `targetFloor2` through `targetFloor`.
                        // This means there is a CAVE under the block we are about to dig.

                        // If we dig `targetFloor`, we expose the void.
                        // THEN we can place a block.

                        // BUT, if we dig it, we can't step on it yet.
                        // So the flow is:
                        // Dig `targetFloor`.
                        // Check `targetFloor2`. If AIR, Place Block at `targetFloor2`.
                        // Then Step.

                        // So, let's proceed to dig, but add a post-dig check?
                        // Or we can assume we handle it after dig?
                        // The current code returns after dig. So we need to handle it NOW.

                        // Wait, if there is a VOID under the block we want to dig, that means `blkFloor` is effectively a "Bridge" already?
                        // Yes, `blkFloor` is the floor. If we dig it, we make a hole.
                        // Why do we want to dig it? purely to descend Y level.
                        // If we dig it, we fall 2 blocks.

                        // So, if we dig `blkFloor`, we MUST place a block at `targetFloor2` (Y-2).
                        // Can we place it before stepping?
                        // Yes, after digging `blkFloor`, `targetFloor2` becomes visible/accessible from above?
                        // Yes, we confront the hole.

                        // STRATEGY: 
                        // 1. Dig `blkFloor`.
                        // 2. Check `targetFloor2`. If Air:
                        // 3. Place block at `targetFloor2`.
                        // 4. If fail to place, DO NOT STEP. Instead, Turn/Backtrack.

                        // Let's modify the code flow to Dig -> Check -> Bridge -> Step.
                    } catch (e) {
                        console.log("Bridge error prep: " + e.message);
                    }
                } else {
                    console.log("[DigDown] No blocks to bridge! Cannot descend here.");
                    // Turn corner
                    await this.turnCorner(cardinal);
                    return;
                }
            }

            // Dig the floor
            await this.bot.dig(blkFloor);

            // Post-Dig Check: Is there a floor below?
            // Allow a small delay for block update
            await this.bot.waitForTicks(2);

            const freshBlkBelow = this.bot.blockAt(targetFloor2);
            if (!freshBlkBelow || freshBlkBelow.boundingBox !== 'block') {
                // It is indeed AIR/Liquid.
                // Try to bridge.
                const placeable = this.bot.inventory.items().find(i =>
                    i.name === 'cobblestone' || i.name === 'dirt' ||
                    i.name === 'stone' || i.name === 'netherrack' ||
                    i.name === 'andesite' || i.name === 'diorite' || i.name === 'granite'
                );

                if (placeable) {
                    try {
                        await this.bot.equip(placeable, 'hand');
                        // Place against the side of the block under us? Or any neighbor of `targetFloor2`.
                        // targetFloor2 is at (forward, -2).
                        // Neighbors: (forward, -3) ?? 
                        // Actually we can place against the block UNDER us (0, -2)? 
                        // No, we are standing on (0, -1). The block under us is (0, -2).
                        // Is (0, -2) exposed to (forward, -2)? Yes, they are neighbors.
                        const blockUnderUs = this.bot.blockAt(botPos.offset(0, -1, 0)); // The block we are standing on.
                        // targetFloor2 is neighbor to blockUnderUs ?? NO.
                        // botPos is (0,0,0). blockUnderUs is (0,-1,0).
                        // targetFloor is (1,-1,0). targetFloor2 is (1,-2,0).
                        // blockUnderUs (0,-1,0) is diagonal to targetFloor2? No.
                        // They usually share a face? No. Vertical gap?

                        // We need a stable block neighbor to targetFloor2.
                        // Maybe the block BELOW `blockUnderUs`? -> (0, -2, 0).
                        // If (0,-2,0) exists, we can place against it to fill (1,-2,0).

                        // If we can't find a support, we can't bridge.
                        const refBlock = this.bot.blockAt(botPos.offset(0, -2, 0)); // Valid support?
                        if (refBlock && refBlock.boundingBox === 'block') {
                            await this.bot.placeBlock(refBlock, forward); // Place in direction of forward
                            console.log("[DigDown] Bridged gap!");
                        } else {
                            // Try placing against ANY neighbor
                            console.log("[DigDown] No support for bridging! Aborting step.");
                            await this.turnCorner(cardinal);
                            return;
                        }
                    } catch (e) {
                        console.log(`[DigDown] Bridging failed: ${e.message}`);
                        await this.turnCorner(cardinal);
                        return;
                    }
                } else {
                    console.log("[DigDown] No blocks to bridge after dig! Abort step.");
                    await this.turnCorner(cardinal);
                    return;
                }
            }

            // Proceed to Step (logic below)
            return; // run() is called repeatedly, so we return to let tick reset state? 
            // Wait, if we return here, we won't execute Step 4 (Move Forward).
            // We WANT to move forward if safe.
            // The original code had `return` inside the `if (blkFloor)` block?
            // Yes, lines 118-119: `dig(blkFloor); return;`.
            // If we return, we don't move. We just dug the hole.
            // Next tick, blkFloor is AIR. So we skip Step 3.
            // And go to Step 4: Move Forward.

            // SO:
            // 1. We dig. 
            // 2. We check if safe.
            // 3. If NOT safe (Void), we Bridge.
            // 4. If Bridge OK -> Return. Next tick we move.
            // 5. If Bridge FAIL -> Turn Corner.
            // Correct.
        }

        // Move forward logic
        // Target CENTER of the block to avoid wall friction
        const walkTarget = targetBody.offset(0.5, 0, 0.5);
        const distSq = this.bot.entity.position.distanceSquared(walkTarget);

        console.log(`[DigDown] Move Check. DistSq: ${distSq.toFixed(3)}. Target: ${walkTarget}`);

        if (distSq > 0.2) {
            console.log(`[DigDown] Moving forward...`);
            // Manual move
            await this.bot.lookAt(walkTarget);
            this.bot.setControlState('forward', true);
            // Wait until close
            let stuck = 0;
            while (this.bot.entity.position.distanceSquared(walkTarget) > 0.2 && stuck < 40) { // Increased timeout to 2s
                await this.bot.waitForTicks(1);
                stuck++;
            }
            this.bot.setControlState('forward', false);
            console.log(`[DigDown] Move finished. Stuck ticks: ${stuck}`);
        } else {
            console.log(`[DigDown] Already at target. Skipping move.`);
        }
    }

    async turnCorner(currentCardinal) {
        console.log("[DigDown] Turning corner...");
        // Turn 90 degrees right
        const newYaw = currentCardinal - (Math.PI / 2);
        await this.bot.look(newYaw, 0);
        await this.bot.waitForTicks(5);
    }
}

module.exports = DigDown;
