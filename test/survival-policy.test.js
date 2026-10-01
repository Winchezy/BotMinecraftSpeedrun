const test=require('node:test');
const assert=require('node:assert/strict');
const {decideActivity,constrainCombat}=require('../src/lib/SurvivalPolicy');
const GetFood=require('../src/tasks/GetFood');
function bot(items=[]) {
    return {food:4,health:8,inventory:{items:()=>items},isInCombat:()=>false};
}
test('danger and combat take priority over hunger and regeneration',()=>{
    const b=bot([{name:'cooked_beef',count:1}]);
    b.actions={current:{owner:'water'}};
    assert.equal(decideActivity(b).activity,'escape');
    b.actions.current.owner='combat';
    assert.equal(decideActivity(b).activity,'combat');
    b.actions.current=null;
    assert.equal(decideActivity(b).activity,'food');
    b.food=20;
    assert.equal(decideActivity(b).activity,'regenerate');
    b.health=20;
    assert.equal(decideActivity(b).activity,'progress');
});
test('starvation and low health override fighting without provoking ignored mobs',()=>{
    const b=bot();
    assert.equal(constrainCombat(b,'fight'),'retreat');
    assert.equal(constrainCombat(b,'ignore'),'ignore');
    b.food=20;b.health=20;
    assert.equal(constrainCombat(b,'fight'),'fight');
});
test('ready cooked food is consumed before furnace preparation or ongoing cooking',async()=>{
    const b=bot([{name:'cooked_beef',count:1},{name:'beef',count:3}]);
    b.version='1.20.4';
    let consumed=0;
    b.equip=async()=>{};b.consume=async()=>{consumed++;b.food+=8;};
    const task=new GetFood(b);
    task.cooking={isDone:()=>false,run:async()=>{throw new Error('Cooking must wait');}};
    task.preparation={run:async()=>{throw new Error('Preparation must wait');}};
    await task.run();
    assert.equal(consumed,1);
    assert.equal(b.survivalDecision.activity,'eat');
    assert.equal(task.isDone(),false);
});
test('food task does not consume or prepare resources during active combat',async()=>{
    const b=bot([{name:'cooked_beef',count:1}]);b.version='1.20.4';
    b.isInCombat=()=>true;
    b.equip=async()=>{throw new Error('Combat owns equipment');};
    await new GetFood(b).run();
});

test('raw meat does not interrupt progression when fed and cooked food remains',()=>{
    const b=bot([{name:'beef',count:9},{name:'cooked_beef',count:3}]);
    b.food=20;b.health=20;
    for(let i=0;i<10;i++)assert.equal(decideActivity(b).activity,'progress');
    b.food=6;
    assert.equal(decideActivity(b).activity,'food');
});

test('a full food task finishes without cooking more raw meat or preparing fuel',async()=>{
    const b=bot([{name:'beef',count:9},{name:'cooked_beef',count:3}]);
    b.version='1.20.4';b.food=20;b.health=20;
    const task=new GetFood(b);
    task.cooking={isDone:()=>false,run:async()=>{throw new Error('Unnecessary cooking');}};
    task.preparation={run:async()=>{throw new Error('Unnecessary fuel');}};
    await task.run();
    assert.equal(task.isDone(),true);
    assert.equal(task.hasFailed,false);
});
