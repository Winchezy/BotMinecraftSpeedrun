const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const GetFood = require('../src/tasks/GetFood');
const { equipDefense } = require('../src/lib/Defense');
const TorchLighting = require('../src/lib/TorchLighting');
const Agent = require('../src/Agent');

test('recognizes and eats glow berries in a starvation emergency', async () => {
    let consumed = false;
    const bot = { version: '1.20.4', food: 0, inventory: { items: () => [{ name: 'glow_berries' }] },
        equip: async () => {}, consume: async () => { consumed = true; } };
    await new GetFood(bot).run();
    assert.equal(consumed, true);
});

test('prepares fuel instead of eating raw mutton at normal hunger', async () => {
    const bot = { version: '1.20.4', food: 12, inventory: { items: () => [{ name: 'mutton', count: 2 }] },
        consume: async () => { throw new Error('Raw meat must be cooked'); } };
    const task = new GetFood(bot);
    await task.run();
    assert.equal(task.preparation.name, 'GetWood');
    assert.equal(task.isDone(), false);
});

test('equips shield in the off hand and the strongest available sword', async () => {
    const equipped = [];
    const bot = { inventory: { items: () => [{ name: 'stone_sword' }, { name: 'shield' }, { name: 'iron_sword' }] },
        equip: async (item, slot) => equipped.push([item.name, slot]) };
    assert.deepEqual(await equipDefense(bot), { shield: true, weapon: true });
    assert.deepEqual(equipped, [['shield', 'off-hand'], ['iron_sword', 'hand']]);
});

test('places a torch below light level seven on a safe nearby floor', async () => {
    let placed = false;
    const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {},
        inventory: { items: () => [{ name: 'torch' }] },
        blockAt: p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty', light: 6, skyLight: 0 },
        equip: async () => {}, placeBlock: async () => { placed = true; }, chat: () => {} };
    await new TorchLighting(bot).tick();
    assert.equal(placed, true);
});

test('does not place a torch when light is seven', async () => {
    const bot = { entity: { position: new Vec3(0, 64, 0) },
        blockAt: () => ({ light: 7, skyLight: 0 }),
        inventory: { items: () => { throw new Error('No torch needed'); } } };
    await new TorchLighting(bot).tick();
});

test('schedules shield crafting when planks and iron are ready', async () => {
    const agent = Object.create(Agent.prototype);
    agent.bot = { version: '1.20.4', chat: () => {} };
    agent.ensureTable = async () => {};
    agent.currentTask = null;
    assert.equal(await agent.ensureShield([], () => false, name => ({ iron_ingot: 1, planks: 6 }[name] || 0)), true);
    assert.equal(agent.currentTask.name, 'Craft_shield');
});
