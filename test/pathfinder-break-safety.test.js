const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const {configurePathfinder}=require('../src/lib/Survival');
test('navigation rejects unloaded blocks and retains native liquid and falling-block checks',()=>{
    const registry=require('minecraft-data')('1.20.4');
    const Block=require('prismarine-block')(registry);
    let neighbor='air';
    const bot={version:'1.20.4',registry,entities:{},
        blockAt:pos=>{const block=Block.fromStateId(registry.blocksByName[neighbor].minStateId,0);block.position=pos;return block;},
        pathfinder:{setMovements(m){this.movements=m;}}};
    configurePathfinder(bot);
    const m=bot.pathfinder.movements;
    assert.equal(m.safeToBreak({physical:false,safe:false}),false);
    assert.equal(m.safeOrBreak({physical:false,safe:false,position:new Vec3(0,64,0)},[]),100);
    const stone=Block.fromStateId(registry.blocksByName.stone.minStateId,0);stone.position=new Vec3(0,64,0);
    assert.ok(m.safeToBreak(stone));
    neighbor='water';assert.equal(m.safeToBreak(stone),false);
    neighbor='gravel';assert.equal(m.safeToBreak(stone),false);
    neighbor='air';
    const table=Block.fromStateId(registry.blocksByName.crafting_table.minStateId,0);table.position=stone.position;
    assert.equal(m.safeToBreak(table),false);
});
