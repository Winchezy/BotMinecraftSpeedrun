const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const Agent = require('../src/Agent');
const GetFood = require('../src/tasks/GetFood');

test('pauses mining while low health regenerates with enough food', async () => {
    const messages = [];
    const agent = Object.create(Agent.prototype);
    agent.bot = {
        health: 13, food: 20, entity: { position: new Vec3(0, 64, 0) },
        blockAt: () => ({ name: 'air' }), stopDigging: () => {},
        pathfinder: { stop: () => {} }, chat: message => messages.push(message)
    };
    agent.currentTask = { name: 'DigDown' };
    agent.deathRecovery = { pending: false };
    await agent.tick();
    assert.equal(agent.currentTask, null);
    assert.equal(agent.waitingForHealth, true);
    assert.match(messages[0], /recupere ma vie/);
});

test('does not chase food into a hostile mob group', async () => {
    const bot = {
        version: '1.20.4', inventory: { items: () => [] },
        entity: { position: new Vec3(0, 64, 0) },
        entities: {
            cow: { name: 'cow', position: new Vec3(5, 64, 0) },
            skeleton: { name: 'skeleton', position: new Vec3(6, 64, 1) }
        }
    };
    const task = new GetFood(bot);
    task.searchForPasture = async () => false;
    await task.run();
    assert.equal(task.failureReason, 'Zone de nourriture dangereuse');
});

test('searches a reachable pasture when no animal is visible', async () => {
    const bot = {
        version: '1.20.4', inventory: { items: () => [] }, entities: {},
        entity: { position: new Vec3(0, 64, 0) },
        findBlocks: options => options.matching.includes(require('minecraft-data')('1.20.4').blocksByName.grass_block.id) ? [new Vec3(25, 63, 0)] : [],
        blockAt: point => point.y<=63 ? {name:'grass_block',boundingBox:'block'} : { name: 'air', boundingBox: 'empty', skyLight: 15 },
        pathfinder: {
            movements: {},
            getPathFromTo: function * () {
                yield { result: { status: 'partial', path: [new Vec3(5, 64, 0)] } };
                yield { result: { status: 'success', path: [new Vec3(5, 64, 0), new Vec3(25, 64, 0)] } };
            },
            goto: async () => { bot.entity.position = new Vec3(25, 64, 0); }
        }
    };
    const task = new GetFood(bot);
    await task.run();
    assert.equal(task.searchMoves, 1);
    assert.equal(task.isDone(), false);
    assert.deepEqual(bot.entity.position, new Vec3(25, 64, 0));
});
