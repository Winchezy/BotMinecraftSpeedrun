const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ActionController = require('../src/lib/ActionController');
const Task = require('../src/lib/Task');

function fixture() {
    const bot = new EventEmitter();
    const calls = [];
    let finishDig;
    bot.clearControlStates = () => calls.push('clear');
    bot.setControlState = (key, value) => calls.push([key, value]);
    bot.stopDigging = () => calls.push('stopDig');
    bot.deactivateItem = () => calls.push('releaseItem');
    bot.dig = () => new Promise(resolve => { finishDig = resolve; });
    bot.pathfinder = { movements: { baseline: true },
        setGoal: goal => calls.push(['goal', goal]), setMovements(m) { this.movements = m; } };
    bot.pvp = { forceStop: () => calls.push('stopCombat') };
    bot.collectBlock = { targets: { clear: () => calls.push('cancelCollect') } };
    bot.actions = new ActionController(bot);
    return { bot, calls, finish: () => finishDig?.() };
}

test('combat immediately interrupts a pending task and cancels movement, mining and collection', async () => {
    const { bot, calls, finish } = fixture();
    const work = bot.actions.run('agent', 20, async () => {
        await bot.dig();
        bot.pathfinder.setGoal('oldTree');
    });
    await new Promise(resolve => setImmediate(resolve));
    const defense = bot.actions.acquire('combat', 80);
    await work;
    assert.ok(calls.includes('stopDig'));
    assert.ok(calls.includes('cancelCollect'));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'goal' && c[1] === null));
    await bot.actions.with(defense, () => bot.pathfinder.setGoal('safeRetreat'));
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(c => Array.isArray(c) && c[1] === 'oldTree'), false);
    assert.deepEqual(calls.at(-1), ['goal', 'safeRetreat']);
});

test('late task cleanup cannot clear the controls belonging to a new activity', async () => {
    const { bot, calls } = fixture();
    const work = bot.actions.run('agent', 20, async () => {
        try { await bot.dig(); }
        finally { bot.clearControlStates(); }
    });
    await new Promise(resolve => setImmediate(resolve));
    const defense = bot.actions.acquire('combat', 80);
    await bot.actions.with(defense, () => bot.setControlState('left', true));
    await work;
    assert.deepEqual(calls.at(-1), ['left', true]);
});

test('water takes precedence over combat and normal tasks wait until it releases control', async () => {
    const { bot } = fixture();
    const combat = bot.actions.acquire('combat', 80);
    const water = bot.actions.acquire('water', 100);
    assert.equal(bot.actions.valid(combat), false);
    let ran = false;
    await bot.actions.run('agent', 20, () => { ran = true; });
    assert.equal(ran, false);
    bot.actions.release(water);
    await bot.actions.run('agent', 20, () => { ran = true; });
    assert.equal(ran, true);
});

test('a revoked task cannot report a false completion after an interruption', async () => {
    const { bot } = fixture();
    const lease = bot.actions.acquire('agent', 20);
    const task = new Task(bot);
    let resume;
    const late = bot.actions.with(lease, async () => {
        await new Promise(resolve => { resume = resolve; });
        task.complete();
    });
    bot.actions.acquire('combat', 80);
    resume();
    await late;
    assert.equal(task.isDone(), false);
    assert.equal(task.hasFailed, false);
});

test('restores the original movement configuration when an emergency ends', async () => {
    const { bot } = fixture();
    const baseline = bot.pathfinder.movements;
    const combat = bot.actions.acquire('combat', 80);
    await bot.actions.with(combat, () => bot.pathfinder.setMovements({ canDig: false }));
    bot.actions.cancel('Menace terminee');
    assert.equal(bot.pathfinder.movements, baseline);
});

test('death revokes control and no activity starts before respawn', () => {
    const { bot } = fixture();
    const lease = bot.actions.acquire('agent', 20);
    bot.emit('death');
    assert.equal(bot.actions.valid(lease), false);
    assert.equal(bot.actions.acquire('combat', 80), null);
    bot.emit('spawn');
    assert.ok(bot.actions.acquire('agent', 20));
});
