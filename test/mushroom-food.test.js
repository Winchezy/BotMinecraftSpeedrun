const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const MushroomFood = require('../src/lib/MushroomFood');

test('crafts stew only with both mushroom colors and a bowl', async () => {
    let crafted = false;
    const bot = { version:'1.20.4', inventory: { items:()=>[{name:'brown_mushroom'},{name:'red_mushroom'},{name:'bowl'}] },
        recipesFor:()=>[{}], craft:async()=>{crafted=true;} };
    assert.equal(await new MushroomFood(bot,{}).run(),true);
    assert.equal(crafted,true);
});

test('with only brown mushrooms searches specifically for red mushrooms', async () => {
    const bot = { version:'1.20.4', registry:require('minecraft-data')('1.20.4'), inventory:{items:()=>[{name:'brown_mushroom'}]},
        findBlocks: options => {
            assert.deepEqual(options.matching,[bot.registry.blocksByName.red_mushroom.id]);
            return [];
        }, pathfinder:{movements:{}} };
    assert.equal(await new MushroomFood(bot,{}).run(),false);
});

for (const name of ['cobblestone','spruce_leaves','spruce_log']) {
test(`refuses to remove ${name} over an unsupported drop`, async () => {
    const bot = { version:'1.20.4', entity:{position:new Vec3(0,80,0)},
        blockAt:p=>p.y===79 ? {position:p,name,boundingBox:'block'} : {position:p,name:'air',boundingBox:'empty'},
        dig:async()=>{throw new Error('Unsafe drop must not be dug');} };
    assert.equal(await new MushroomFood(bot,{}).lowerPillar(new Vec3(0,65,0)),false);
});
}

test('lowers an isolated pillar one block onto solid support', async () => {
    let dug = false;
    const bot = { version:'1.20.4', entities:{}, entity:{position:new Vec3(0,80,0)},
        blockAt:p=>({position:p,name:p.x===0 && p.z===0 && p.y<80 ? 'cobblestone':'air',
            boundingBox:p.x===0 && p.z===0 && p.y<80 ? 'block':'empty'}),
        canDigBlock:()=>true, inventory:{items:()=>[{name:'stone_pickaxe'}]},
        pathfinder:{stop(){}}, clearControlStates(){}, equip:async()=>{},
        dig:async block=>{assert.equal(block.position.y,79);dug=true;}, waitForTicks:async()=>{} };
    assert.equal(await new MushroomFood(bot,{}).lowerPillar(new Vec3(0,65,0)),true);
    assert.equal(dug,true);
    assert.equal(bot.isDismantlingPillar,false);
});

test('places and verifies a support before removing a suspended log',async()=>{
    let placed=false,dug=false;
    const bot={version:'1.20.4',entities:{},entity:{position:new Vec3(0,80,0)},
        inventory:{items:()=>[{name:'spruce_log',count:3}]},
        blockAt:p=>({position:p,name:p.x===0 && p.z===0 && (p.y===79 || p.y===78 && placed)?'spruce_log':'air',
            boundingBox:p.x===0 && p.z===0 && (p.y===79 || p.y===78 && placed)?'block':'empty'}),
        pathfinder:{setGoal(){},stop(){}},clearControlStates(){},equip:async()=>{},canDigBlock:()=>true,
        placeBlock:async(block,face)=>{assert.equal(block.position.y,79);assert.equal(face.y,-1);placed=true;},
        dig:async()=>{assert.equal(placed,true);dug=true;},waitForTicks:async()=>{}};
    assert.equal(await new MushroomFood(bot,{}).lowerPillar(new Vec3(0,65,0)),true);
    assert.equal(dug,true);
});
