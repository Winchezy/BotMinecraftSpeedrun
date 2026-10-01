const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const {circleDirection}=require('../src/lib/CombatStrafe');
const CombatTactics=require('../src/lib/CombatTactics');
const {guardWithShield}=require('../src/lib/Defense');
function setup() {
    let attacks=0;
    const controls={};
    const target={name:'zombie',position:new Vec3(0.5,64,-1),yaw:Math.PI};
    const bot={entities:{},entity:{position:new Vec3(0.5,64,0.5),yaw:0,onGround:true},
        heldItem:{name:'stone_sword'},isInCombat:()=>true,
        pvp:{target,attackRange:3,attemptAttack:()=>{attacks++;}},
        pathfinder:{setGoal(){}},setControlState:(name,value)=>{controls[name]=value;},
        blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty'})};
    const tactics=new CombatTactics(bot);
    return {bot,tactics,target,controls,attacks:()=>attacks};
}
test('circle direction handles wrapped angles and does not circle a target facing away',()=>{
    const target={position:new Vec3(0,64,0),yaw:-Math.PI+0.1};
    assert.ok(circleDirection(target,new Vec3(0,64,1)));
    assert.equal(circleDirection({...target,yaw:0},new Vec3(0,64,1)),null);
});
test('circle movement stops at an unsupported edge and on retreat',()=>{
    const {bot,tactics,target,controls}=setup();
    tactics.tick('fight',target);
    assert.equal(controls.left,true);
    const terrain=bot.blockAt;
    bot.blockAt=p=>p.x>0.9&&p.y<64?{name:'air',boundingBox:'empty'}:terrain(p);
    tactics.tick('fight',target);
    assert.equal(controls.left,false);
    bot.blockAt=terrain;
    tactics.tick('fight',target);
    tactics.tick('retreat',target);
    assert.equal(controls.left,false);
});
test('attack window prevents duplicate sequences and releases after seven ticks',()=>{
    const {bot,tactics,target,attacks}=setup();
    tactics.safeJump=()=>false;
    bot.pvp.attemptAttack();bot.pvp.attemptAttack();
    assert.equal(attacks(),1);
    assert.equal(bot.combatAttackPending,true);
    for(let i=0;i<7;i++)tactics.tick('fight',target);
    bot.pvp.attemptAttack();
    assert.equal(attacks(),2);
    tactics.reset();assert.equal(bot.combatAttackPending,false);
});
test('hunting outside survival combat is not stalled by the attack window',()=>{
    const {bot,attacks}=setup();bot.isInCombat=()=>false;
    bot.pvp.attemptAttack();bot.pvp.attemptAttack();
    assert.equal(attacks(),2);
});
test('shield guard does not raise shield in the middle of the plugin strike',async()=>{
    const {bot,target}=setup();
    bot.getEquipmentDestSlot=()=>45;
    bot.inventory={slots:{45:{name:'shield'}}};
    bot.pathfinder.isMoving=()=>false;
    bot.pvp.timeToNextAttack=3;bot.combatAttackPending=true;
    bot.lookAt=async()=>{throw new Error('Strike must keep its own orientation');};
    bot.activateItem=()=>{throw new Error('Shield must wait for strike');};
    await guardWithShield(bot,target,'fight');
});
