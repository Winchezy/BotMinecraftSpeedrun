const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const CombatTactics = require('../src/lib/CombatTactics');
const CombatPreparation = require('../src/lib/CombatPreparation');

function fighter() {
    let strikes = 0;
    const controls = {};
    const bot = {
        entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 },
        heldItem: { name: 'stone_sword' }, isInCombat: () => true, entities: {},
        blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
        setControlState: (name, value) => { controls[name] = value; },
        pathfinder: { setGoal: () => {} },
        pvp: { target: { name: 'zombie', position: new Vec3(0.5, 64, -1) }, attackRange: 3.5,
            attemptAttack: () => { strikes++; } }
    };
    return { bot, controls, strikes: () => strikes };
}

test('starts a jump and defers the strike until the descending phase', () => {
    const { bot, controls, strikes } = fighter();
    new CombatTactics(bot);
    bot.pvp.attemptAttack();
    assert.equal(controls.jump, true);
    assert.equal(strikes(), 0);
    bot.entity.onGround = false;
    bot.entity.position.y = 65;
    bot.entity.velocity.y = 0.1;
    bot.pvp.attemptAttack();
    assert.equal(strikes(), 0);
    bot.entity.velocity.y = -0.08;
    bot.pvp.attemptAttack();
    assert.equal(strikes(), 1);
    assert.equal(controls.jump, false);
});

test('attacks normally under a low ceiling rather than attempting a critical jump', () => {
    const { bot, controls, strikes } = fighter();
    const terrain = bot.blockAt;
    bot.blockAt = p => p.y === 66 ? { name: 'stone', boundingBox: 'block' } : terrain(p);
    new CombatTactics(bot);
    bot.pvp.attemptAttack();
    assert.equal(strikes(), 1);
    assert.notEqual(controls.jump, true);
});

test('a failed jump falls back to a normal strike instead of stalling combat', () => {
    const { bot, strikes } = fighter();
    const tactics = new CombatTactics(bot);
    bot.pvp.attemptAttack();
    for (let i = 0; i < 16; i++) tactics.tick('fight', bot.pvp.target);
    bot.pvp.attemptAttack();
    assert.equal(strikes(), 1);
});

test('dodges an approaching arrow and alternates sides on the next volley', () => {
    const { bot, controls } = fighter();
    const tactics = new CombatTactics(bot);
    bot.entities.arrow = { name: 'arrow', position: new Vec3(0.5, 65, -6), velocity: new Vec3(0, 0, 1) };
    tactics.tick('fight', bot.pvp.target);
    const first = controls.left;
    assert.equal(controls.left || controls.right, true);
    for (let i = 0; i < 5; i++) tactics.tick('fight', bot.pvp.target);
    tactics.tick('fight', bot.pvp.target);
    assert.notEqual(controls.left, first);
});

test('refuses a projectile dodge toward an unsupported ledge', () => {
    const { bot, controls } = fighter();
    bot.blockAt = p => ({ name: 'air', boundingBox: 'empty' });
    bot.entities.fire = { name: 'small_fireball', position: new Vec3(0.5, 65, -6), velocity: new Vec3(0, 0, 1) };
    new CombatTactics(bot).tick('retreat', bot.pvp.target);
    assert.equal(controls.left, false);
    assert.equal(controls.right, false);
});

test('ignores arrows moving away from the bot', () => {
    const { bot } = fighter();
    bot.entities.arrow = { name: 'arrow', position: new Vec3(0.5, 65, -6), velocity: new Vec3(0, 0, -1) };
    assert.equal(new CombatTactics(bot).incomingProjectile(), undefined);
});

test('prepares a stone sword before resuming objectives once the area is safe', async () => {
    const bot = { version: '1.20.4', entities: {}, entity: { position: new Vec3(0, 64, 0) }, weaponNeeded: true,
        inventory: { items: () => [{ name: 'cobblestone', count: 2 }, { name: 'stick', count: 1 }, { name: 'crafting_table', count: 1 }] },
        findBlock: () => null, chat: () => {} };
    const prep = new CombatPreparation(bot);
    assert.equal(await prep.run(), true);
    assert.equal(prep.task.name, 'Craft_stone_sword');
});

test('does not lower defenses for crafting during combat', async () => {
    const bot = { inventory: { items: () => [] }, isInCombat: () => true };
    const prep = new CombatPreparation(bot);
    assert.equal(await prep.run(), false);
    assert.equal(prep.task, null);
});

test('requests a sword after thirty seconds of repeated mob interruptions', () => {
    const bot = {};
    const prep = new CombatPreparation(bot);
    prep.noteBlocked(1000);
    prep.noteBlocked(20000);
    assert.notEqual(bot.weaponNeeded, true);
    prep.noteBlocked(31000);
    assert.equal(bot.weaponNeeded, true);
});
