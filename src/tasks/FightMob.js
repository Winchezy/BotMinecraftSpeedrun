const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

class FightMob extends Task {
    constructor(bot, mobType, killCount = 1) {
        super(bot);
        this.name = `Fight_${mobType}`;
        this.mobType = mobType;
        this.killCount = killCount;
        this.killed = 0;
        this.mcData = require('minecraft-data')(bot.version);
    }

    async run() {
        if (this.killed >= this.killCount) {
            this.complete();
            return;
        }

        // Safety: Don't hunt if low health
        if (this.bot.health < 7) {
            console.log(`[${this.name}] Health critical (${this.bot.health}). Pausing fight task.`);
            await this.bot.waitForTicks(20);
            return;
        }

        // Find target mob
        const mob = this.bot.nearestEntity(entity => {
            return entity.name === this.mobType && entity.type === 'mob';
        });

        if (!mob) {
            console.log(`[${this.name}] No ${this.mobType} found nearby, searching...`);
            await this.wander();
            return;
        }

        console.log(`[${this.name}] Found ${this.mobType} at distance ${this.bot.entity.position.distanceTo(mob.position).toFixed(1)}`);

        // Equip best weapon
        await this.equipBestWeapon();

        // Use PvP plugin to attack
        try {
            this.bot.pvp.attack(mob);

            // Wait for mob to die or timeout
            const startTime = Date.now();
            while (mob.isValid && Date.now() - startTime < 30000) {
                await this.bot.waitForTicks(10);
            }

            if (!mob.isValid) {
                this.killed++;
                console.log(`[${this.name}] Killed ${this.mobType} (${this.killed}/${this.killCount})`);
            }

            this.bot.pvp.stop();
        } catch (err) {
            console.log(`[${this.name}] Fight error: ${err.message}`);
            this.bot.pvp.stop();
        }
    }

    async equipBestWeapon() {
        const weapons = this.bot.inventory.items().filter(i =>
            i.name.includes('sword') || i.name.includes('axe')
        );

        if (weapons.length > 0) {
            // Sort by tier (diamond > iron > stone > wood)
            const tierOrder = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
            weapons.sort((a, b) => {
                const tierA = tierOrder.findIndex(t => a.name.includes(t));
                const tierB = tierOrder.findIndex(t => b.name.includes(t));
                return tierA - tierB;
            });
            await this.bot.equip(weapons[0], 'hand');
        }
    }

    async wander() {
        const p = this.bot.entity.position;
        const x = p.x + (Math.random() * 40 - 20);
        const z = p.z + (Math.random() * 40 - 20);
        this.bot.pathfinder.setGoal(new goals.GoalNear(x, p.y, z, 2));
        await this.bot.waitForTicks(40);
    }
}

module.exports = FightMob;
