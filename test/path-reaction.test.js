const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { planCompletePath } = require('../src/lib/Pathing');

function combatBot() {
    return { entity: { position: new Vec3(0, 64, 0) }, isInCombat: () => true,
        pathfinder: { movements: {}, *getPathFromTo(movements, start, goal, options) {
            assert.equal(options.tickTimeout, 15);
            yield { result: { status: 'partial', generatedNodes: 10, path: [] } };
            yield { result: { status: 'success', generatedNodes: 20, path: [new Vec3(1, 64, 0)] } };
        } } };
}

test('ordinary task planning yields and aborts when combat interrupts it', async () => {
    assert.equal((await planCompletePath(combatBot(), {})).status, 'interrupted');
});

test('a multi-slice retreat search can finish while combat is active', async () => {
    const bot = combatBot();
    const route = await planCompletePath(bot, {}, 500, bot.pathfinder.movements, { allowCombat: true });
    assert.equal(route.status, 'success');
});

test('an urgent threat update interrupts even a combat retreat search', async () => {
    const bot = combatBot();
    const route = await planCompletePath(bot, {}, 500, bot.pathfinder.movements,
        { allowCombat: true, shouldInterrupt: () => true });
    assert.equal(route.status, 'interrupted');
});
