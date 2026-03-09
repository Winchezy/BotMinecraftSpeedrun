const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

class FindStronghold extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'FindStronghold';
        this.mcData = require('minecraft-data')(bot.version);
        this.lastThrowPos = null;
        this.directions = [];
    }

    async run() {
        // Check if we're already at the stronghold (end portal frame nearby)
        const endPortalFrame = this.bot.findBlock({
            matching: this.mcData.blocksByName.end_portal_frame.id,
            maxDistance: 32
        });

        if (endPortalFrame) {
            console.log(`[${this.name}] Found End Portal Frame!`);
            this.complete();
            return;
        }

        // Use Eye of Ender to find stronghold
        const eyeOfEnder = this.bot.inventory.items().find(i => i.name === 'ender_eye');
        if (!eyeOfEnder) {
            this.fail("No Eye of Ender");
            return;
        }

        console.log(`[${this.name}] Throwing Eye of Ender...`);

        // Equip and throw
        await this.bot.equip(eyeOfEnder, 'hand');
        await this.bot.look(0, 0); // Look straight ahead

        const currentPos = this.bot.entity.position.clone();

        // Activate (throw) the eye
        await this.bot.activateItem();

        // Watch for the ender eye entity
        await this.bot.waitForTicks(40); // Wait for eye to fly

        // Find the eye entity
        const eye = this.bot.nearestEntity(e => e.name === 'eye_of_ender');

        if (eye) {
            const eyePos = eye.position;
            const direction = eyePos.minus(currentPos).normalize();

            this.directions.push({
                from: currentPos,
                direction: direction
            });

            console.log(`[${this.name}] Eye flew towards ${eyePos.x.toFixed(0)}, ${eyePos.z.toFixed(0)}`);

            // Move in that direction
            const targetX = currentPos.x + direction.x * 100;
            const targetZ = currentPos.z + direction.z * 100;

            this.bot.pathfinder.setGoal(new goals.GoalXZ(targetX, targetZ));
            await this.bot.waitForTicks(200); // Move for ~10 seconds
        } else {
            // Eye went down - stronghold is below us!
            console.log(`[${this.name}] Stronghold should be below! Digging down...`);
            await this.digDown();
        }
    }

    async digDown() {
        const pos = this.bot.entity.position.floored();

        for (let y = pos.y - 1; y > pos.y - 30; y--) {
            const block = this.bot.blockAt(new (require('vec3'))(pos.x, y, pos.z));
            if (block && block.type !== this.mcData.blocksByName.air.id) {
                try {
                    await this.bot.dig(block);
                } catch (e) {
                    console.log(`[${this.name}] Dig error: ${e.message}`);
                    break;
                }
            }

            // Check for end portal frame
            const frame = this.bot.findBlock({
                matching: this.mcData.blocksByName.end_portal_frame.id,
                maxDistance: 16
            });

            if (frame) {
                console.log(`[${this.name}] Found End Portal Frame!`);
                this.complete();
                return;
            }
        }
    }
}

module.exports = FindStronghold;
