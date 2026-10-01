const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../src/Agent');

test('crafts planks from existing logs when recovering a lost pickaxe', async () => {
    const agent = Object.create(Agent.prototype);
    agent.bot = { version: '1.20.4' };
    const inventory = [
        { name: 'spruce_log', count: 8 },
        { name: 'crafting_table', count: 1 },
        { name: 'stick', count: 1 }
    ];
    const count = name => inventory.filter(item => item.name.includes(name))
        .reduce((total, item) => total + item.count, 0);
    const has = name => inventory.some(item => item.name.includes(name));

    await agent.handleEarlyGame(inventory, has, count);

    assert.equal(agent.currentTask.name, 'Craft_spruce_planks');
});

test('five raw iron is enough to stop mining for a single iron pickaxe', async () => {
    const agent = Object.create(Agent.prototype);
    agent.bot = { version: '1.20.4', findBlock: () => null };
    agent.mcData = require('minecraft-data')('1.20.4');
    agent.failedTasks = {};
    agent.ensurePickaxeRedundancy = async () => false;
    agent.ensureTable = async () => {};
    const inventory = [
        { name: 'stone_pickaxe', count: 1 },
        { name: 'raw_iron', count: 5 },
        { name: 'cobblestone', count: 34 }
    ];
    const count = name => inventory.filter(item => item.name.includes(name))
        .reduce((total, item) => total + item.count, 0);
    const has = name => inventory.some(item => item.name.includes(name));

    await agent.handleIronStage(inventory, has, count);

    assert.equal(agent.currentTask.name, 'Craft_furnace');
});

test('descends to iron level before selecting a distant cave ore', async () => {
    const agent = Object.create(Agent.prototype);
    agent.bot = { version: '1.20.4', entity: { position: { y: 72 } } };
    agent.ensurePickaxeRedundancy = async () => false;
    const inventory = [{ name: 'stone_pickaxe', count: 1 }];
    const count = name => inventory.filter(item => item.name.includes(name))
        .reduce((total, item) => total + item.count, 0);
    const has = name => inventory.some(item => item.name.includes(name));

    await agent.handleIronStage(inventory, has, count);

    assert.equal(agent.currentTask.name, 'DigDown');
    assert.equal(agent.currentTask.targetY, 54);
});
