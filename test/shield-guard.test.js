const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { guardWithShield } = require('../src/lib/Defense');

function fixture(distance, moving = false) {
    const calls = [];
    const bot = {
        entity: { position: new Vec3(0, 64, 0) },
        getEquipmentDestSlot: () => 45,
        inventory: { slots: { 45: { name: 'shield' } } },
        pvp: { attackRange: 3, timeToNextAttack: 5 },
        pathfinder: { isMoving: () => moving, setGoal: goal => calls.push(['goal', goal]) },
        lookAt: async p => calls.push(['look', p]),
        activateItem: offhand => calls.push(['block', offhand])
    };
    return { bot, target: { position: new Vec3(distance, 64, 0), height: 1.99 }, calls };
}

test('faces a ranged attacker and raises the offhand shield when retreat is blocked', async () => {
    const { bot, target, calls } = fixture(8);
    await guardWithShield(bot, target, 'retreat');
    assert.equal(calls[0][0], 'look');
    assert.equal(calls[0][1].x, 8);
    assert.deepEqual(calls[1], ['block', true]);
});

test('stops chasing within melee reach to face and block between strikes', async () => {
    const { bot, target, calls } = fixture(2, true);
    await guardWithShield(bot, target, 'fight');
    assert.deepEqual(calls.map(c => c[0]), ['goal', 'look', 'block']);
});

test('does not interrupt the PvP shield release needed to strike', async () => {
    const { bot, target, calls } = fixture(2);
    bot.pvp.timeToNextAttack = -1;
    await guardWithShield(bot, target, 'fight');
    assert.deepEqual(calls, []);
});

test('does not turn away from an active escape route', async () => {
    const { bot, target, calls } = fixture(8, true);
    await guardWithShield(bot, target, 'retreat');
    assert.deepEqual(calls, []);
});

test('resumes approaching when the enemy moves outside melee reach', async () => {
    const { bot, target, calls } = fixture(5);
    bot.shieldStoppedChase = true;
    await guardWithShield(bot, target, 'fight');
    assert.equal(bot.shieldStoppedChase, false);
    assert.equal(calls[0][0], 'goal');
    assert.equal(calls[0][1].entity, target);
});
