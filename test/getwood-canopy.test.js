const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const GetWood = require('../src/tasks/GetWood');

test('collects reachable wood under a canopy instead of attempting to reach the sky', async () => {
    let count = 0;
    const log = { name: 'spruce_log', position: new Vec3(2, 80, 0) };
    const bot = {
        version: '1.20.4', entity: { position: new Vec3(0.5, 80, 0.5) },
        inventory: { items: () => count ? [{ name: 'spruce_log', count }] : [] },
        findBlocks: () => [log.position],
        blockAt: () => ({ name: 'spruce_leaves', skyLight: 0 }),
        collectBlock: { collect: async block => { assert.equal(block, log); count++; } }
    };
    const task = new GetWood(bot, 1);
    task.findReachableLog = async () => log;
    await task.run();
    assert.equal(count, 1);
    assert.equal(task.surfaceTask, undefined);
    await task.run();
    assert.equal(task.isDone(), true);
});

test('does not start a surface trip if combat interrupts the search for wood', async () => {
    const bot = { version: '1.20.4', inventory: { items: () => [] },
        findBlocks: () => [], isInCombat: () => true };
    const task = new GetWood(bot);
    task.findReachableLog = async () => null;
    await task.run();
    assert.equal(task.surfaceTask, undefined);
});

test('descends from a tree even with enough logs instead of completing on the canopy', async () => {
    let descended = false;
    const bot = { version: '1.20.4', canDigBlock: () => true, chat: () => {},
        inventory: { items: () => [{ name: 'spruce_log', count: 3 }] },
        findBlocks: () => { throw new Error('Do not choose a distant tree before descending'); } };
    const task = new GetWood(bot, 3);
    task.treeEscape = { onTree: () => true, run: async () => { descended = true; return true; } };
    await task.run();
    assert.equal(descended, true);
    assert.equal(task.isDone(), false);
});

test('does not wander between tree tops when no safe descent exists', async () => {
    const bot = { version: '1.20.4', canDigBlock: () => true, chat: () => {} };
    const task = new GetWood(bot);
    task.treeEscape = { onTree: () => true, run: async () => false };
    task.wander = async () => { throw new Error('Unsafe canopy wandering'); };
    await task.run();
    assert.equal(task.isDone(), false);
});

test('agent finishes the tree escape before starting a different task', async () => {
    const agent = Object.create(require('../src/Agent').prototype);
    let descended = false;
    agent.bot = { canDigBlock: () => true, entity: { position: new Vec3(0, 80, 0), onGround: true },
        blockAt: () => ({ name: 'air' }) };
    agent.deathRecovery = { pending: null };
    agent.treeEscape = { onTree: () => true, run: async () => { descended = true; return true; } };
    agent.currentTask = { run: () => { throw new Error('Do not start mining from the tree'); } };
    await agent.tick();
    assert.equal(descended, true);
});
