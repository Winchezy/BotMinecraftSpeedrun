const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

class BuildNetherPortal extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'BuildNetherPortal';
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        // Check if we have enough obsidian (minimum 10, ideal 14)
        const obsidianCount = this.bot.inventory.items()
            .filter(i => i.name === 'obsidian')
            .reduce((a, b) => a + b.count, 0);

        if (obsidianCount < 10) {
            this.fail(`Not enough obsidian (have ${obsidianCount}, need 10)`);
            return;
        }

        // Check if portal already exists nearby
        const portal = this.bot.findBlock({
            matching: this.mcData.blocksByName.nether_portal.id,
            maxDistance: 64
        });

        if (portal) {
            console.log(`[${this.name}] Portal already exists!`);
            this.complete();
            return;
        }

        console.log(`[${this.name}] Building Nether Portal...`);

        // Find a flat area
        const pos = this.bot.entity.position.floored();

        // Portal structure (4 wide, 5 tall frame)
        // We'll build at current position + offset
        const baseX = pos.x + 2;
        const baseY = pos.y;
        const baseZ = pos.z;

        const obsidian = this.bot.inventory.items().find(i => i.name === 'obsidian');
        if (!obsidian) {
            this.fail("No obsidian in inventory");
            return;
        }

        await this.bot.equip(obsidian, 'hand');

        // Build portal frame (minimal 4x5 with corners optional)
        const portalBlocks = [
            // Bottom row
            new Vec3(baseX, baseY, baseZ),
            new Vec3(baseX + 1, baseY, baseZ),
            // Left column
            new Vec3(baseX - 1, baseY + 1, baseZ),
            new Vec3(baseX - 1, baseY + 2, baseZ),
            new Vec3(baseX - 1, baseY + 3, baseZ),
            // Right column
            new Vec3(baseX + 2, baseY + 1, baseZ),
            new Vec3(baseX + 2, baseY + 2, baseZ),
            new Vec3(baseX + 2, baseY + 3, baseZ),
            // Top row
            new Vec3(baseX, baseY + 4, baseZ),
            new Vec3(baseX + 1, baseY + 4, baseZ),
        ];

        for (const blockPos of portalBlocks) {
            try {
                // Find a reference block to place against
                const below = this.bot.blockAt(blockPos.offset(0, -1, 0));
                if (below && below.type !== this.mcData.blocksByName.air.id) {
                    await this.bot.placeBlock(below, new Vec3(0, 1, 0));
                    await this.bot.waitForTicks(5);
                }
            } catch (e) {
                console.log(`[${this.name}] Place error at ${blockPos}: ${e.message}`);
            }
        }

        // Light the portal with flint and steel
        const flint = this.bot.inventory.items().find(i => i.name === 'flint_and_steel');
        if (flint) {
            await this.bot.equip(flint, 'hand');
            const insideBlock = this.bot.blockAt(new Vec3(baseX, baseY + 1, baseZ));
            if (insideBlock) {
                await this.bot.activateBlock(insideBlock);
            }
        } else {
            console.log(`[${this.name}] No flint and steel to light portal!`);
        }

        this.complete();
    }
}

module.exports = BuildNetherPortal;
