// Common arbitration; action ownership remains enforced by ActionController.
const RAW = new Set(['beef','porkchop','mutton','rabbit','cod','salmon','chicken']);
const READY = /^(cooked_|bread$|apple$|golden_apple$|baked_potato$|carrot$|melon_slice$|glow_berries$|sweet_berries$|beetroot$|potato$|dried_kelp$|mushroom_stew$|rabbit_stew$|pumpkin_pie$|cookie$)/;
function decideActivity(bot) {
    const owner = bot.actions?.current?.owner;
    if (owner === 'danger' || owner === 'water') return {activity:'escape',reason:owner};
    if (bot.isInCombat?.() || owner === 'combat') return {activity:'combat',reason:'menace active'};
    if (bot.health < 16 && bot.food >= 20) return {activity:'regenerate',reason:'recuperation de vie'};
    const items = bot.inventory?.items?.() || [];
    const raw = items.some(i=>RAW.has(i.name));
    const ready = items.some(i=>i.count > 0 && READY.test(i.name));
    if ((raw && !ready) || bot.food <= 10 || (bot.health < 16 && bot.food < 20))
        return {activity:'food',reason:bot.food<=6?'faim critique':raw?'cuisson':'nourriture pour recuperer'};
    return {activity:'progress',reason:'besoins vitaux satisfaits'};
}
function constrainCombat(bot, proposed) {
    // Overrides for clearing a blocked route cannot force a starving,
    // badly injured bot to fight. Neutral classification remains in MobThreats.
    if (proposed === 'fight' && (bot.health < 7 || (bot.food <= 6 && bot.health < 12))) return 'retreat';
    return proposed;
}
module.exports={decideActivity,constrainCombat};
