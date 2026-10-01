const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { MobAwareness, decideResponse } = require('../src/lib/MobThreats');

test('a stalled retreat can defend against one nearby skeleton but never neutral or dangerous mobs', () => {
    const { shouldFightStalemate } = require('../src/lib/MobThreats');
    const state = { stuckMs: 31000, distance: 4.5, health: 19, sword: true, nearbyHostiles: 1, threatState: 'vigilance' };
    assert.equal(shouldFightStalemate({ name: 'skeleton' }, state), true);
    for (const name of ['enderman', 'spider', 'creeper', 'blaze', 'warden']) {
        assert.equal(shouldFightStalemate({ name }, state), false);
    }
    for (const change of [{ stuckMs: 29000 }, { distance: 8 }, { health: 8 }, { sword: false }, { nearbyHostiles: 2 }, { threatState: 'passive' }]) {
        assert.equal(shouldFightStalemate({ name: 'skeleton' }, { ...state, ...change }), false);
    }
});

function setup(name = 'creeper', x = 20) {
    const mob = { id: 1, name, position: new Vec3(x, 64, 0), metadata: {} };
    const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: { 1: mob }, registry: require('minecraft-data')('1.20.4') };
    return { mob, bot, awareness: new MobAwareness(bot) };
}

test('a distant inactive creeper is observed without fleeing', () => {
    const { mob, awareness } = setup();
    const observed = awareness.observe(mob, 1000);
    assert.equal(observed.state, 'passive');
    assert.equal(decideResponse(mob, { distance: 14, health: 20, nearbyHostiles: 1, threatState: 'passive' }), 'ignore');
});

test('approaching a stationary mob does not count as being pursued', () => {
    const { mob, bot, awareness } = setup();
    awareness.observe(mob, 1000);
    bot.entity.position.x = 3;
    awareness.observe(mob, 1500);
    bot.entity.position.x = 6;
    assert.notEqual(awareness.observe(mob, 2000).state, 'hostile');
});

test('two observed movements toward the bot indicate probable pursuit', () => {
    const { mob, awareness } = setup('zombie', 12);
    awareness.observe(mob, 1000);
    mob.position.x = 11;
    awareness.observe(mob, 1500);
    mob.position.x = 10;
    assert.equal(awareness.observe(mob, 2000).state, 'hostile');
});

test('movement by a distant mob or a mob on another level does not establish pursuit', () => {
    for (const [x, y] of [[32, 64], [12, 54]]) {
        const { mob, awareness } = setup('zombie', x);
        mob.position.y = y;
        awareness.observe(mob, 1000);
        mob.position.x -= 1;
        awareness.observe(mob, 1500);
        mob.position.x -= 1;
        assert.notEqual(awareness.observe(mob, 2000).state, 'hostile');
        awareness.markAttack(mob, 2100);
        assert.equal(awareness.observe(mob, 2200).state, 'hostile');
    }
});

test('movement behind a sealed wall does not establish pursuit', () => {
    const { mob, bot, awareness } = setup('zombie', 12);
    bot.blockAt = () => ({ boundingBox: 'block' });
    awareness.observe(mob, 1000);
    mob.position.x = 11;
    awareness.observe(mob, 1500);
    mob.position.x = 10;
    assert.notEqual(awareness.observe(mob, 2000).state, 'hostile');
});

test('a swelling creeper and an identified attacker are hostile immediately', () => {
    const { mob, bot, awareness } = setup();
    const index = bot.registry.entitiesByName.creeper.metadataKeys.indexOf('swell_dir');
    mob.metadata[index] = 1;
    assert.equal(awareness.observe(mob, 1000).state, 'hostile');
    const other = setup('zombie');
    other.awareness.markAttack(other.mob, 1000);
    assert.equal(other.awareness.observe(other.mob, 1500).state, 'hostile');
});

test('an unprovoked Enderman is left alone', () => {
    const { mob, awareness } = setup('enderman', 3);
    assert.equal(awareness.observe(mob, 1000).state, 'passive');
});

test('an Enderman walking toward the bot stays neutral without aggression or a known attack', () => {
    const { mob, awareness } = setup('enderman', 12);
    awareness.observe(mob, 1000);
    mob.position.x = 11;
    awareness.observe(mob, 1500);
    mob.position.x = 10;
    const observed = awareness.observe(mob, 2000);
    assert.equal(observed.state, 'passive');
    assert.equal(observed.evidence, 'aucune attaque observee');
    awareness.markAttack(mob, 2100);
    assert.equal(awareness.observe(mob, 2200).state, 'hostile');
});
