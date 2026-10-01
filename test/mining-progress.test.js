const test = require('node:test');
const assert = require('node:assert/strict');
const {Vec3}=require('vec3');
const MineBlock=require('../src/tasks/MineBlock');
function setup() {
    const a=new Vec3(2,64,0),b=new Vec3(3,64,0);
    let items=[],calls=[];
    const bot={version:'1.20.4',game:{dimension:'overworld'},entities:{},
        entity:{position:new Vec3(0,64,0)},inventory:{items:()=>items},
        blockAt:p=>({name:p.equals(a)||p.equals(b)?'iron_ore':'air',position:p}),
        findBlocks:()=>[a,b],pathfinder:{movements:{},getPathTo:()=>({status:'success',path:[]})},
        waitForTicks:async()=>{},collectBlock:{collect:async block=>{calls.push(block.position);}},
        isInCombat:()=>false};
    const task=new MineBlock(bot,'iron_ore',1);
    task.equipBestTool=async()=>{};
    return {bot,task,a,b,calls,setItems:value=>{items=value;}};
}
test('plugin success without expected inventory gain does not complete mining',async()=>{
    const {task,a}=setup();
    await assert.rejects(task.collectAndVerify({position:a}),/aucun objet/);
    assert.equal(task.isDone(),false);
});
test('delayed raw iron inventory updates confirm collection and complete the goal',async()=>{
    const {bot,task,a,setItems}=setup();
    bot.waitForTicks=async()=>setItems([{name:'raw_iron',count:1}]);
    assert.equal(await task.collectAndVerify({position:a}),1);
    assert.equal(task.isDone(),true);
});
test('failed collection selects another ore on the next run',async()=>{
    const {bot,task,a,b,calls,setItems}=setup();
    await task.run();
    assert.equal(task.blockDeferred(a),true);
    bot.collectBlock.collect=async block=>{calls.push(block.position);setItems([{name:'raw_iron',count:1}]);};
    await task.run();
    assert.deepEqual(calls,[a,b]);
    assert.equal(task.isDone(),true);
});
test('cooldown survives task recreation, expires and is isolated by bot and dimension',()=>{
    const {bot,task,a}=setup();
    task.deferBlock(a,'noPath',1000);
    const next=new MineBlock(bot,'iron_ore');
    assert.equal(next.blockDeferred(a,2000),true);
    bot.game.dimension='the_nether';
    assert.equal(next.blockDeferred(a,2000),false);
    bot.game.dimension='overworld';
    assert.equal(new MineBlock(setup().bot,'iron_ore').blockDeferred(a,2000),false);
    assert.equal(next.blockDeferred(a,61000),false);
});
test('incomplete path is skipped before attempting collection',async()=>{
    const {bot,task,a,b,calls,setItems}=setup();
    bot.pathfinder.getPathTo=(moves,goal)=>({status:goal.x===a.x?'noPath':'success',path:[]});
    bot.collectBlock.collect=async block=>{calls.push(block.position);setItems([{name:'raw_iron',count:1}]);};
    await task.run();
    assert.deepEqual(calls,[b]);
    assert.equal(task.blockDeferred(a),true);
});
