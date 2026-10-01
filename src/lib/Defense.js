async function equipDefense(bot) {
    const items = bot.inventory.items();
    const shield = items.find(i => i.name === 'shield');
    if (shield) {
        const slot = bot.getEquipmentDestSlot?.('off-hand');
        if (slot == null || bot.inventory.slots?.[slot]?.name !== 'shield') await bot.equip(shield, 'off-hand');
    }
    const tier = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden'];
    const weapons = items.filter(i => /_(sword|axe)$/.test(i.name));
    weapons.sort((a,b) => {
        const rank = item => (item.name.endsWith('_sword') ? 0 : 10) + tier.findIndex(t => item.name.startsWith(t));
        return rank(a) - rank(b);
    });
    if (weapons[0] && bot.heldItem?.name !== weapons[0].name) await bot.equip(weapons[0], 'hand');
    return { shield: !!shield, weapon: !!weapons[0] };
}

// Le pathfinder dirige aussi le regard : reprendre la visee une fois arrete.
async function guardWithShield(bot, target, mode) {
    if (!target?.position || !bot.entity) return;
    const slot = bot.getEquipmentDestSlot('off-hand');
    if (bot.inventory.slots[slot]?.name !== 'shield') return;
    const moving = bot.pathfinder.isMoving();
    const inReach = bot.entity.position.distanceTo(target.position) <= (bot.pvp.attackRange || 3);
    if (mode === 'fight' && !inReach && bot.shieldStoppedChase) {
        bot.shieldStoppedChase = false;
        if (bot.usingHeldItem) bot.deactivateItem();
        const { goals } = require('mineflayer-pathfinder');
        bot.pathfinder.setGoal(new goals.GoalFollow(target, bot.pvp.followRange || 2), true);
        return;
    }
    if (mode === 'fight' && inReach && moving) {
        bot.pathfinder.setGoal(null);
        bot.shieldStoppedChase = true;
    }
    else if (moving) return; // La fuite garde sa direction et sa vitesse.
    // Le plugin PvP baisse le bouclier pendant son attaque asynchrone.
    if (mode === 'fight' && (bot.pvp.timeToNextAttack < 0 || bot.combatAttackPending)) return;
    await bot.lookAt(target.position.offset(0, Math.min(target.height || 1.6, 1.6) / 2, 0), true);
    if (!bot.usingHeldItem) bot.activateItem(true);
}

module.exports = { equipDefense, guardWithShield };
