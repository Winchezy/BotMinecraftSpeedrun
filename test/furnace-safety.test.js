const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const SmeltTask = require('../src/tasks/SmeltTask');
const GetFood = require('../src/tasks/GetFood');
const MineBlock = require('../src/tasks/MineBlock');

test('refuses to place a furnace beside a creeper', async () => {
    const bot = { version: '1.20.4', entity: { position: new Vec3(0, 64, 0) },
        entities: { mob: { name: 'creeper', position: new Vec3(10, 64, 0) } } };
    const task = new SmeltTask(bot, 'raw_iron', 'iron_ingot');
    assert.equal(await task.placeFurnace({ name: 'furnace' }), null);
    assert.equal(task.failureReason, 'Mobs sur le trajet du four');
});

test('collects finished iron without requiring additional fuel', async () => {
    const items = [];
    let closed = 0;
    const pos = new Vec3(1, 64, 0);
    const bot = { version: '1.20.4', entity: { position: new Vec3(0, 64, 0) }, entities: {},
        inventory: { items: () => items }, findBlocks: () => [pos], blockAt: () => ({ position: pos }),
        pathfinder: { movements: {}, getPathFromTo: function * () { yield { result: { status: 'success', path: [pos] } }; } },
        openFurnace: async () => ({ outputItem: () => ({ name: 'iron_ingot' }),
            takeOutput: async () => items.push({ name: 'iron_ingot', count: 3 }), close: () => closed++ }) };
    const task = new SmeltTask(bot, 'raw_iron', 'iron_ingot', 3);
    await task.run();
    assert.equal(task.isDone(), true);
    assert.equal(task.hasFailed, false);
    assert.equal(closed, 1);
});

test('prefers cooked meat even when raw meat appears first in inventory', () => {
    const bot = { version: '1.20.4', inventory: { items: () => [{ name: 'beef' }, { name: 'cooked_beef' }] } };
    assert.equal(new GetFood(bot).findEdible().name, 'cooked_beef');
});

test('cooks raw meat before eating when hunger permits waiting', async () => {
    let consumed = false;
    const bot = { version: '1.20.4', food: 12,
        inventory: { items: () => [{ name: 'beef', count: 2 }, { name: 'coal' }, { name: 'furnace' }] },
        consume: async () => { consumed = true; } };
    const task = new GetFood(bot);
    let cooked = false;
    task.cooking = { run: async () => { cooked = true; }, isDone: () => false };
    await task.run();
    assert.equal(cooked, true);
    assert.equal(consumed, false);
});

test('critical hunger without nearby danger waits for cooking instead of eating raw beef', async () => {
    const bot = {version:'1.20.4',food:0,health:1,entities:{},entity:{position:new Vec3(0,64,0)},
        inventory:{items:()=>[{name:'beef',count:2}]}, consume:async()=>{throw new Error('Raw beef eaten without danger');}};
    const task = new GetFood(bot);
    let cooked = false;
    task.cooking = {run:async()=>{cooked=true;},isDone:()=>false};
    await task.run();
    assert.equal(cooked,true);
});

test('actual starvation damage permits one safe raw portion before cooking',async()=>{
    let eaten=false;
    const bot={version:'1.20.4',food:0,health:2,lastStarvationDamage:Date.now(),entities:{},entity:{position:new Vec3(0,64,0)},
        inventory:{items:()=>[{name:'beef',count:2}]},equip:async()=>{},consume:async()=>{eaten=true;}};
    await new GetFood(bot).run();
    assert.equal(eaten,true);
});

test('uses rotten flesh only as a last resort when health and hunger are critical',async()=>{
    let eaten=false;
    const bot={version:'1.20.4',food:0,health:1,entities:{},entity:{position:new Vec3(0,64,0)},
        inventory:{items:()=>[{name:'rotten_flesh',count:3}]},equip:async()=>{},consume:async()=>{eaten=true;}};
    await new GetFood(bot).run();
    assert.equal(eaten,true);
});

test('eats available cooked food through to full hunger for recovery', async () => {
    const bot = {version:'1.20.4',food:18,health:1,
        inventory:{items:()=>[{name:'cooked_beef',count:1}]}, equip:async()=>{},consume:async()=>{bot.food=20;}};
    const task = new GetFood(bot);
    await task.run();
    assert.equal(bot.food,20);
});

test('uses an existing passage with digging disabled and restores movements', async () => {
    const original = { canDig: true };
    let inspected;
    const bot = { registry: require('minecraft-data')('1.20.4'), entity: { position: new Vec3(0, 64, 0) }, entities: {},
        pathfinder: { movements: original,
            getPathFromTo: function * (movements) { inspected = movements; yield { result: { status: 'success', path: [] } }; },
            setMovements: function (movements) { this.movements = movements; },
            goto: async () => {} } };
    const task = Object.create(MineBlock.prototype);
    task.bot = bot;
    task.name = 'Mine_iron_ore';
    assert.equal(await task.useExistingPassage({}), true);
    assert.equal(inspected.canDig, false);
    assert.equal(inspected.countScaffoldingItems(), 0);
    assert.equal(bot.pathfinder.movements, original);
});
