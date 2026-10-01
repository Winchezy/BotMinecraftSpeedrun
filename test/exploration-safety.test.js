const test = require('node:test');
const assert = require('node:assert/strict');
const { safeExplorationPath, safeExplorationBreak } = require('../src/lib/ExplorationSafety');
const { Vec3 } = require('vec3');

function terrain(hole) {
    return {blockAt:point=>hole?.(point) ? {name:'air',boundingBox:'empty'} :
        point.y<64 ? {name:'stone',boundingBox:'block'} : {name:'air',boundingBox:'empty'}};
}
test('accepts a wide supported route',()=>{
    assert.equal(safeExplorationPath(terrain(),[{x:0,y:64,z:0},{x:1,y:64,z:0}]),true);
});
test('rejects a route beside a deep drop even when its own floor is solid',()=>{
    assert.equal(safeExplorationPath(terrain(p=>p.x===1),[{x:0,y:64,z:0}]),false);
});
test('rejects missing support and routes requiring a bridge',()=>{
    assert.equal(safeExplorationPath(terrain(p=>p.x===0),[{x:0,y:64,z:0}]),false);
    assert.equal(safeExplorationPath(terrain(),[{x:0,y:64,z:0,toPlace:[{}]}]),false);
});
test('accepts a one-block step next to the route',()=>{
    assert.equal(safeExplorationPath(terrain(p=>p.x===1 && p.y===63),[{x:0,y:64,z:0}]),true);
});

test('can open dirt at foot height but never remove the floor beneath the bot',()=>{
    const bot={entity:{position:new Vec3(0,64,0)},entities:{},blockAt:()=>({name:'air',boundingBox:'empty'})};
    assert.equal(safeExplorationBreak(bot,{name:'dirt',position:new Vec3(1,64,0)}),true);
    assert.equal(safeExplorationBreak(bot,{name:'dirt',position:new Vec3(0,63,0)}),false);
});

test('does not open dirt beside lava or underneath falling gravel',()=>{
    const position=new Vec3(1,64,0);
    const bot={entity:{position:new Vec3(0,64,0)},entities:{},blockAt:()=>({name:'lava'})};
    assert.equal(safeExplorationBreak(bot,{name:'dirt',position}),false);
    bot.blockAt=()=>({name:'gravel'});
    assert.equal(safeExplorationBreak(bot,{name:'dirt',position}),false);
});
