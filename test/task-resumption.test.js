const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../src/Agent');
const Task = require('../src/lib/Task');
const GetFood = require('../src/tasks/GetFood');

function setup() {
    const bot = { food: 20, health: 20, chat() {}, isInCombat: () => false };
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, { bot, stage: 'IRON', deathRecovery: { pending: false }, mobRoutePauseUntil: 0 });
    const task = new Task(bot);
    task.name = 'MineBlock';
    task.target = { x: 3, y: 50, z: 2 };
    agent.currentTask = task;
    agent.suspendForFood();
    agent.currentTask = null;
    return { agent, bot, task };
}

test('food interruption resumes the same task with its target and progress', () => {
    const { agent, task } = setup();
    task.progress = 4;
    assert.equal(agent.resumeSuspendedTask(), true);
    assert.equal(agent.currentTask, task);
    assert.equal(agent.currentTask.progress, 4);
    assert.deepEqual(agent.currentTask.target, { x: 3, y: 50, z: 2 });
    assert.equal(agent.suspendedTask, null);
});

test('survival conditions prevent resuming mining', () => {
    for (const condition of ['hunger', 'health', 'combat', 'death', 'ledge', 'route']) {
        const { agent, bot } = setup();
        if (condition === 'hunger') bot.food = 6;
        if (condition === 'health') bot.health = 8;
        if (condition === 'combat') bot.isInCombat = () => true;
        if (condition === 'death') agent.deathRecovery.pending = true;
        if (condition === 'ledge') agent.unsafeDigSite = {};
        if (condition === 'route') agent.mobRoutePauseUntil = Date.now() + 10000;
        assert.equal(agent.resumeSuspendedTask(), false, condition);
        assert.ok(agent.suspendedTask);
    }
});

test('completed or previous-stage tasks are discarded', () => {
    for (const stale of ['completed', 'stage']) {
        const { agent, task } = setup();
        if (stale === 'completed') task.done = true;
        else agent.stage = 'DIAMOND';
        assert.equal(agent.resumeSuspendedTask(), false);
        assert.equal(agent.suspendedTask, null);
    }
});

test('an active food task is not overwritten or saved as a progression task', () => {
    const { agent, task } = setup();
    const food = Object.create(GetFood.prototype);
    agent.currentTask = food;
    agent.suspendForFood();
    assert.equal(agent.suspendedTask.task, task);
    assert.equal(agent.resumeSuspendedTask(), false);
    assert.equal(agent.currentTask, food);
});
