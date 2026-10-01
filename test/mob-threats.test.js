const test = require('node:test');
const assert = require('node:assert/strict');
const { isHostileMob, decideResponse } = require('../src/lib/MobThreats');

const context = { distance: 2, health: 20, armed: true, nearbyHostiles: 1, recentDamage: false };
const mob = name => ({ type: 'mob', name });

test('never initiates combat with an unprovoked Enderman or other neutral mob', () => {
    for (const name of ['enderman', 'piglin', 'zombified_piglin', 'spider']) {
        assert.equal(isHostileMob(mob(name)), false);
        assert.equal(decideResponse(mob(name), context), 'ignore');
    }
    assert.equal(decideResponse(mob('enderman'), { ...context, recentDamage: true }), 'retreat');
});

test('avoids distant or dangerous hostiles and fights only when cornered and equipped', () => {
    assert.equal(decideResponse(mob('skeleton'), { ...context, distance: 15 }), 'ignore');
    assert.equal(decideResponse(mob('skeleton'), { ...context, distance: 11, recentDamage: true }), 'retreat');
    assert.equal(decideResponse(mob('skeleton'), { ...context, distance: 7 }), 'retreat');
    assert.equal(decideResponse(mob('creeper'), context), 'retreat');
    assert.equal(decideResponse(mob('creeper'), { ...context, distance: 14 }), 'retreat');
    assert.equal(decideResponse(mob('zombie'), { ...context, distance: 11, nearbyHostiles: 3 }), 'retreat');
    assert.equal(decideResponse(mob('zombie'), { ...context, armed: false }), 'retreat');
    assert.equal(decideResponse(mob('zombie'), context), 'fight');
});
