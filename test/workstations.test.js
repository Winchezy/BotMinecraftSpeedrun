const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const workstations=require('../src/lib/Workstations');

test('remembers only the last placement separately for each workstation and dimension',()=>{
    const bot={game:{dimension:'overworld'}};
    const memory=workstations(bot);
    memory.remember('crafting_table',new Vec3(1,64,0));
    memory.remember('crafting_table',new Vec3(5,64,0));
    memory.remember('furnace',new Vec3(2,64,0));
    assert.equal(memory.locations[memory.key('crafting_table')].x,5);
    assert.equal(memory.locations[memory.key('furnace')].x,2);
    bot.game.dimension='the_nether';
    assert.equal(memory.locations[memory.key('furnace')],undefined);
});

test('does not break an old furnace without a pickaxe',async()=>{
    const bot={entity:{position:new Vec3(0,64,0)},entities:{},inventory:{items:()=>[]},
        blockAt:()=>({name:'furnace'}),dig:()=>{throw new Error('Furnace must be preserved');}};
    const memory=workstations(bot);memory.remember('furnace',new Vec3(2,64,0));
    assert.equal(await memory.recover('furnace'),false);
});

test('refuses an old workstation near hostile mobs',async()=>{
    const bot={entity:{position:new Vec3(0,64,0)},entities:{1:{name:'creeper',position:new Vec3(2,64,0)}},
        inventory:{items:()=>[]},blockAt:()=>({name:'air',boundingBox:'empty'})};
    const memory=workstations(bot);memory.remember('crafting_table',new Vec3(2,64,0));
    assert.equal(await memory.recover('crafting_table'),false);
});

test('empties and closes a safe furnace before mining and collecting it',async()=>{
    const items=[{name:'stone_pickaxe',count:1}];
    const position=new Vec3(2,64,0);
    let closed=false,input={name:'raw_iron'},fuel={name:'coal'},output={name:'iron_ingot'};
    const bot={registry:require('minecraft-data')('1.20.4'),entity:{position:new Vec3(0,64,0)},entities:{},
        inventory:{items:()=>items},blockAt:p=>({position:p,name:p.equals(position)?'furnace':p.y<64?'stone':'air',boundingBox:p.y<64 || p.equals(position)?'block':'empty'}),
        canDigBlock:()=>true,equip:async()=>{},waitForTicks:async()=>{},
        openFurnace:async()=>({inputItem:()=>input,fuelItem:()=>fuel,outputItem:()=>output,
            takeInput:async()=>{input=null;},takeFuel:async()=>{fuel=null;},takeOutput:async()=>{output=null;},close:()=>{closed=true;}}),
        dig:async()=>{assert.equal(closed,true);assert.equal(input,null);assert.equal(fuel,null);assert.equal(output,null);items.push({name:'furnace',count:1});},
        pathfinder:{movements:{},getPathFromTo:function*(){yield{result:{status:'success',path:[]}};},
            setMovements:function(m){this.movements=m;},goto:async()=>{}}};
    const memory=workstations(bot);memory.remember('furnace',position);
    assert.equal(await memory.recover('furnace'),true);
    assert.equal(memory.locations[memory.key('furnace')],undefined);
});
