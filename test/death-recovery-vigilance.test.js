const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DeathRecovery = require('../src/lib/DeathRecovery');

test('vigilant creeper outside retreat range does not freeze recovery at its current position', () => {
    const creeper = { id: 1, name: 'creeper', position: new Vec3(9.4, 64, 0) };
    const bot = {
        entities: { 1: creeper },
        mobAwareness: { observations: new Map([[1, { state: 'vigilance' }]]) }
    };
    const recovery = new DeathRecovery(bot, { persist: false });
    const current = new Vec3(0, 64, 0);
    assert.equal(recovery.threatNearCurrent(current), undefined);
    assert.equal(recovery.hostileNear(new Vec3(2, 64, 0), 8), creeper);
    creeper.position.x = 5.9;
    assert.equal(recovery.threatNearCurrent(current), creeper);
    creeper.position.x = 9.4;
    bot.mobAwareness.observations.set(1, { state: 'hostile' });
    assert.equal(recovery.threatNearCurrent(current), creeper);
});
