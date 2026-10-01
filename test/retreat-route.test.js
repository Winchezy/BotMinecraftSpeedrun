const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const {findRetreatRoute}=require('../src/lib/RetreatRoute');

test('finds a retreat down several safe one-block steps',async()=>{
    const bot={registry:require('minecraft-data')('1.20.4'),entity:{position:new Vec3(0,64,0)},
        blockAt:p=>({name:p.y<64-Math.max(0,p.x) ? 'stone':'air',boundingBox:p.y<64-Math.max(0,p.x)?'block':'empty'}),
        pathfinder:{movements:{maxDropDown:1},getPathFromTo:function*(movements,start,goal){
            assert.equal(movements.canDig,false);
            const path=[];
            for(let x=1;x<=goal.x;x++) path.push(new Vec3(x,64-x,0));
            yield{result:{status:'success',path}};
        }}};
    const route=await findRetreatRoute(bot,[{position:new Vec3(-8,64,0)}]);
    assert.ok(route);
    assert.ok(route.target.x>2);
    assert.ok(route.target.y<63);
});

test('does not invent a retreat over unsupported terrain',async()=>{
    const bot={entity:{position:new Vec3(0,64,0)},registry:require('minecraft-data')('1.20.4'),
        blockAt:()=>({name:'air',boundingBox:'empty'}),pathfinder:{movements:{}}};
    assert.equal(await findRetreatRoute(bot,[{position:new Vec3(-8,64,0)}]),null);
});
