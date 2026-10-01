// Dependency planning inspired by Mindcraft; local execution uses safe tasks.
const dataFor = require('minecraft-data');
const count = (bot,name) => bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
function recipes(bot,name) {
    const id = dataFor(bot.version).itemsByName[name]?.id;
    return id == null ? [] : require('prismarine-recipe')(bot.version).Recipe.find(id,null);
}
function chooseRecipe(bot,name) {
    const data = dataFor(bot.version);
    const score = r => r.delta.filter(i=>i.count<0).reduce((n,i)=> {
        const item = data.items[i.id].name;
        const convertible = item.endsWith('_planks') && count(bot,item.replace('_planks','_log'));
        return n+Math.max(0,-i.count-count(bot,item))*(convertible?0.1:1);
    },0);
    return recipes(bot,name).sort((a,b)=>score(a)-score(b))[0];
}
function acquire(bot,name,target,chain) {
    const craft = (item,n=1) => {
        if (chain.includes(item) || chain.length>=12) throw new Error('Dependance cyclique : '+item);
        return new (require('../tasks/CraftTask'))(bot,item,n,chain);
    };
    const wood = () => new (require('../tasks/GetWood'))(bot,
        bot.inventory.items().filter(i=>i.name.endsWith('_log')).reduce((n,i)=>n+i.count,0)+1);
    if (name.endsWith('_log')) return wood();
    if (name.endsWith('_planks') && !count(bot,name.replace('_planks','_log'))) {
        const log = bot.inventory.items().find(i=>i.name.endsWith('_log'));
        return log ? craft(log.name.replace('_log','_planks'),count(bot,log.name.replace('_log','_planks'))+4) : wood();
    }
    const ore = {cobblestone:'stone',coal:'coal_ore',raw_iron:'iron_ore',raw_gold:'gold_ore',diamond:'diamond_ore'}[name];
    if (ore) {
        const tier = n=>({wooden:0,golden:0,stone:1,iron:2,diamond:3,netherite:4}[n.split('_')[0]] ?? -1);
        const pick = ['diamond','raw_gold'].includes(name)?'iron_pickaxe':name==='raw_iron'?'stone_pickaxe':'wooden_pickaxe';
        if (!bot.inventory.items().some(i=>i.name.endsWith('_pickaxe') && tier(i.name)>=tier(pick))) return craft(pick);
        return new (require('../tasks/MineBlock'))(bot,ore,target);
    }
    const raw = {iron_ingot:'raw_iron',gold_ingot:'raw_gold'}[name];
    if (raw) {
        const missing = target-count(bot,name);
        if (count(bot,raw)<missing) return acquire(bot,raw,missing,chain);
        if (!count(bot,'furnace') && !bot.findBlock?.({matching:dataFor(bot.version).blocksByName.furnace.id,maxDistance:4})) return craft('furnace');
        if (!bot.inventory.items().some(i=>['coal','charcoal','stick'].includes(i.name)||i.name.endsWith('_log')||i.name.endsWith('_planks'))) return wood();
        return new (require('../tasks/SmeltTask'))(bot,raw,name,target);
    }
    if (recipes(bot,name).length) return craft(name,target);
    throw new Error('Acquisition non prise en charge : '+name);
}
function nextDependency(bot,name,chain) {
    const recipe=chooseRecipe(bot,name),data=dataFor(bot.version);
    if (!recipe) throw new Error('Aucune recette : '+name);
    for (const i of recipe.delta.filter(i=>i.count<0)) {
        const item=data.items[i.id].name;
        if (count(bot,item)<-i.count) return acquire(bot,item,-i.count,chain);
    }
    return null;
}
module.exports={chooseRecipe,nextDependency,acquire};
