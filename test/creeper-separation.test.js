const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { hasMobAccess, threatNearPoint } = require('../src/lib/MobSafety');

function caveBot(extra = []) {
    const air = new Set();
    for (const x of [0, 2, 3]) for (const y of [64, 65, 66]) air.add(new Vec3(x, y, 0).toString());
    for (const p of extra) air.add(p.toString());
    const creeper = { name: 'creeper', position: new Vec3(3, 64, 0) };
    return { entities: { creeper }, blockAt: p => ({ boundingBox: air.has(p.floored().toString()) ? 'empty' : 'block' }) };
}

test('a creeper in a separate sealed cave does not block work', () => {
    const bot = caveBot();
    assert.equal(hasMobAccess(bot, new Vec3(0, 64, 0), bot.entities.creeper), false);
    assert.equal(threatNearPoint(bot, new Vec3(0, 64, 0), 3), null);
});

test('a zombie in a separate sealed cave does not block work', () => {
    const bot = caveBot();
    bot.entities.creeper.name = 'zombie';
    assert.equal(threatNearPoint(bot, new Vec3(0, 64, 0), 3), null);
});

test('detects when removing the ceiling opens the cave', () => {
    const bot = caveBot([new Vec3(1, 66, 0), new Vec3(1, 67, 0), new Vec3(2, 67, 0), new Vec3(0, 67, 0)]);
    const originalBlockAt = bot.blockAt;
    bot.blockAt = p => p.floored().equals(new Vec3(0, 66, 0)) ? { boundingBox: 'block' } : originalBlockAt(p);
    const origin = new Vec3(0, 64, 0);
    assert.equal(hasMobAccess(bot, origin, bot.entities.creeper), false);
    assert.equal(hasMobAccess(bot, origin, bot.entities.creeper, [new Vec3(0, 66, 0)]), true);
});

test('does not ignore a creeper with an open route around a wall', () => {
    const air = [];
    for (let x = 0; x <= 3; x++) for (const y of [64, 65]) air.push(new Vec3(x, y, 1));
    const bot = caveBot(air);
    assert.equal(hasMobAccess(bot, new Vec3(0, 64, 0), bot.entities.creeper), true);
});

test('DigDown can mine away from a nearby mob in a sealed cave',async()=>{
    const bot=caveBot();bot.version='1.20.4';bot.entity={position:new Vec3(0,64,0)};
    let dug=false;bot.dig=async()=>{dug=true;};
    const task=new (require('../src/tasks/DigDown'))(bot,54);
    assert.equal(await task.safeDig({name:'stone',boundingBox:'block',position:new Vec3(-1,64,0)}),true);
    assert.equal(dug,true);
});

test('DigDown refuses to break the wall that would give the mob access',async()=>{
    const bot=caveBot([new Vec3(1,65,0)]);bot.version='1.20.4';bot.entity={position:new Vec3(0,64,0)};
    bot.dig=async()=>{throw new Error('Do not open the hostile cave');};
    const task=new (require('../src/tasks/DigDown'))(bot,54);
    assert.equal(await task.safeDig({name:'stone',boundingBox:'block',position:new Vec3(1,64,0)}),false);
    assert.match(task.failureReason,/Mobs/);
});
