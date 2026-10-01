// Adapted from Mindcraft src/utils/mcdata.js (MIT).
// Attribution and original license: third-party/mindcraft/.
function calculateLimitingResource(availableItems, requiredItems, discrete = true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        const required = requiredItems[itemType];
        if (!(required > 0)) continue;
        const available = availableItems[itemType] || 0;
        if (available < required * num) {
            limitingResource = itemType;
            num = available / required;
        }
    }
    if (discrete) num = Math.floor(num);
    return { num, limitingResource };
}

function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal') return 8;
    if (fuelName === 'blaze_rod') return 12;
    if (fuelName.endsWith('_log') || fuelName.endsWith('_planks') ||
        fuelName.endsWith('_pickaxe') || fuelName.endsWith('_sword')) return 1.5;
    if (fuelName === 'stick') return 0.5;
    if (fuelName === 'coal_block') return 80;
    if (fuelName === 'lava_bucket') return 100;
    return 0;
}

function craftBatch(bot, recipe, missing) {
    // Prismarine delta also includes returned containers; only negative entries
    // are consumed. Unlike recipe shapes, it is already aggregated by item ID.
    const required = {};
    for (const ingredient of recipe.delta || []) {
        if (ingredient.id >= 0 && ingredient.count < 0)
            required[ingredient.id] = (required[ingredient.id] || 0) - ingredient.count;
    }
    const available = {};
    for (const item of bot.inventory.items())
        available[item.type] = (available[item.type] || 0) + item.count;
    const wanted = Math.ceil(missing / (recipe.result?.count || 1));
    return Math.max(0, Math.min(wanted, calculateLimitingResource(available, required).num));
}

module.exports = { calculateLimitingResource, getFuelSmeltOutput, craftBatch };
