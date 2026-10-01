const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const CraftTask=require('../src/tasks/CraftTask');
const {acquire}=require('../src/lib/CraftDependencies');
const data=require('minecraft-data')('1.20.4');
const Recipe=require('prismarine-recipe')('1.20.4').Recipe;
function setup(initial) {
    const items=initial.map(([name,count])=>({name,count,type:data.itemsByName[name].id}));
    const table={position:new Vec3(1,64,0)};
    const crafted=[];
    const bot={version:'1.20.4',entities:{},entity:{position:new Vec3(0,64,0)},chat(){},
        inventory:{items:()=>items.filter(i=>i.count>0)},findBlock:()=>table,canSeeBlock:()=>true,
        recipesFor:(id,meta,n,table)=>Recipe.find(id,null).filter(r=> (!r.requiresTable||table) &&
            r.delta.filter(i=>i.count<0).every(i=>items.filter(x=>x.type===i.id).reduce((sum,x)=>sum+x.count,0)>=-i.count)),
        craft:async(r,n)=>{
            crafted.push(data.items[r.result.id].name);
            for(const delta of r.delta) {
                let item=items.find(i=>i.type===delta.id);
                if(!item){item={name:data.items[delta.id].name,type:delta.id,count:0};items.push(item);}
                item.count+=delta.count*n;
                assert.ok(item.count>=0);
            }
        }};
    return {bot,crafted};
}
test('iron pickaxe obtains spruce planks and sticks before returning to the original recipe',async()=>{
    const {bot,crafted}=setup([['spruce_log',1],['iron_ingot',3]]);
    const task=new CraftTask(bot,'iron_pickaxe');
    for(let i=0;i<25&&!task.isDone();i++)await task.run();
    assert.equal(task.isDone(),true);
    assert.equal(task.hasFailed,false);
    assert.deepEqual(crafted,['spruce_planks','stick','iron_pickaxe']);
});
test('iron acquisition prepares appropriate tools, ore, furnace and smelting',()=>{
    let {bot}=setup([]);
    assert.equal(acquire(bot,'iron_ingot',3,[]).itemName,'stone_pickaxe');
    ({bot}=setup([['stone_pickaxe',1]]));
    const mine=acquire(bot,'iron_ingot',3,[]);
    assert.equal(mine.blockName,'iron_ore');
    assert.equal(mine.count,3);
    ({bot}=setup([['raw_iron',3],['coal',1]]));
    bot.findBlock=()=>null;
    assert.equal(acquire(bot,'iron_ingot',3,[]).itemName,'furnace');
    bot.findBlock=()=>({position:new Vec3(1,64,0)});
    const smelt=acquire(bot,'iron_ingot',3,[]);
    assert.equal(smelt.inputItem,'raw_iron');
    assert.equal(smelt.count,3);
});
test('dependency failures propagate and cyclic recipes are refused',async()=>{
    const {bot}=setup([]);
    const task=new CraftTask(bot,'iron_pickaxe');
    task.dependencyTask={name:'Mine_iron_ore',isDone:()=>true,hasFailed:true,failureReason:'Mobs sur le trajet'};
    await task.run();
    assert.equal(task.hasFailed,true);
    assert.match(task.failureReason,/Mobs sur le trajet/);
    assert.throws(()=>acquire(bot,'stick',2,['stick']),/cyclique/);
});
