const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');

class FightDragon extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'FightDragon';
        this.mcData = require('minecraft-data')(bot.version);
        this.crystalsDestroyed = 0;
    }

    async run() {
        // Check if dragon is dead (victory!)
        const dragon = this.bot.nearestEntity(e => e.name === 'ender_dragon');

        if (!dragon) {
            // Check for dragon egg or experience
            const dragonEgg = this.bot.findBlock({
                matching: this.mcData.blocksByName.dragon_egg?.id,
                maxDistance: 64
            });

            if (dragonEgg) {
                console.log(`[${this.name}] VICTORY! Dragon defeated!`);
                this.complete();
                return;
            }

            console.log(`[${this.name}] No dragon found, waiting...`);
            await this.bot.waitForTicks(40);
            return;
        }

        console.log(`[${this.name}] Dragon found! Health: unknown`);

        // Strategy:
        // 1. Destroy End Crystals first
        // 2. Attack dragon when it comes down

        // Look for end crystals
        const crystal = this.bot.nearestEntity(e => e.name === 'end_crystal');

        if (crystal) {
            console.log(`[${this.name}] Destroying End Crystal...`);
            await this.destroyCrystal(crystal);
            return;
        }

        // All crystals destroyed, fight dragon
        console.log(`[${this.name}] Attacking Dragon...`);
        await this.attackDragon(dragon);
    }

    async destroyCrystal(crystal) {
        // Use bow if available
        const bow = this.bot.inventory.items().find(i => i.name === 'bow');
        const arrows = this.bot.inventory.items().find(i => i.name.includes('arrow'));

        if (bow && arrows) {
            await this.bot.equip(bow, 'hand');
            await this.bot.lookAt(crystal.position);

            // Charge and shoot
            this.bot.activateItem();
            await this.bot.waitForTicks(20);
            this.bot.deactivateItem();
        } else {
            // Try to punch it if close enough
            const distance = this.bot.entity.position.distanceTo(crystal.position);
            if (distance < 5) {
                this.bot.attack(crystal);
            }
        }

        await this.bot.waitForTicks(20);
        this.crystalsDestroyed++;
    }

    async attackDragon(dragon) {
        // Equip best weapon
        await this.equipBestWeapon();

        const distance = this.bot.entity.position.distanceTo(dragon.position);

        if (distance < 6) {
            // Dragon is close, attack!
            this.bot.pvp.attack(dragon);
            await this.bot.waitForTicks(40);
            this.bot.pvp.stop();
        } else {
            // Use bow
            const bow = this.bot.inventory.items().find(i => i.name === 'bow');
            if (bow) {
                await this.bot.equip(bow, 'hand');
                await this.bot.lookAt(dragon.position);
                this.bot.activateItem();
                await this.bot.waitForTicks(20);
                this.bot.deactivateItem();
            } else {
                // Wait for dragon to come closer
                await this.bot.waitForTicks(40);
            }
        }
    }

    async equipBestWeapon() {
        const weapons = this.bot.inventory.items().filter(i =>
            i.name.includes('sword')
        );

        if (weapons.length > 0) {
            const tierOrder = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
            weapons.sort((a, b) => {
                const tierA = tierOrder.findIndex(t => a.name.includes(t));
                const tierB = tierOrder.findIndex(t => b.name.includes(t));
                return tierA - tierB;
            });
            await this.bot.equip(weapons[0], 'hand');
        }
    }
}

module.exports = FightDragon;
