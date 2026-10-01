const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DeathRecovery = require('../src/lib/DeathRecovery');

function fakeBot(groundExists = () => true) {
    const bot = {
        version: '1.20.4',
        entity: { position: new Vec3(8.5, 64, 0.5) },
        game: { dimension: 'overworld' },
        entities: {},
        blockAt(position) {
            if (position.y < 63) return groundExists(position.x, position.z)
                ? { name: 'stone', boundingBox: 'block' }
                : { name: 'air', boundingBox: 'empty' };
            if (position.y === 63 && groundExists(position.x, position.z)) {
                return { name: 'grass_block', boundingBox: 'block' };
            }
            return { name: 'air', boundingBox: 'empty' };
        },
        pathfinder: {
            movements: { normal: true },
            setMovements(value) { this.movements = value; },
            stop() {},
            async goto(goal) {
                bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
            }
        }
    };
    return bot;
}

test('returns to a safe death location after respawning', async () => {
    const bot = fakeBot();
    const recovery = new DeathRecovery(bot);
    recovery.safeMovements = () => ({ safe: true });
    recovery.onDeath();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    recovery.onSpawn();
    await recovery.run();
    assert.ok(bot.entity.position.distanceTo(new Vec3(8.5, 64, 0.5)) < 3);
    assert.equal(recovery.pending, null);
    assert.deepEqual(bot.pathfinder.movements, { normal: true });
});

test('keeps the death destination for a retry when terrain is inaccessible', async () => {
    const bot = fakeBot(x => x < 4 || x > 12);
    const recovery = new DeathRecovery(bot);
    recovery.safeMovements = () => ({ safe: true });
    recovery.onDeath();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    recovery.onSpawn();
    await recovery.run();
    assert.equal(bot.entity.position.x, 0.5);
    assert.ok(recovery.pending);
    assert.ok(recovery.retryAt > Date.now());
});

test('recognizes hostile mobs and rejects steep edges', () => {
    const bot = fakeBot((x, z) => x <= 0 && z <= 0);
    const recovery = new DeathRecovery(bot);
    bot.entities[1] = { type: 'mob', name: 'skeleton', position: new Vec3(1, 64, 0) };
    assert.equal(recovery.hostileNear(new Vec3(0, 64, 0), 8).name, 'skeleton');
    assert.equal(recovery.stableGround(0, 64, 0), false);
});

test('recovery yields to combat without clearing defense controls or changing its route', async () => {
    const bot = fakeBot();
    const recovery = new DeathRecovery(bot);
    recovery.safeMovements = () => ({ safe: true });
    recovery.onDeath(); recovery.onSpawn();
    const defenseMovements = { defense: true };
    bot.isInCombat = () => true;
    bot.clearControlStates = () => { throw new Error('Defense controls must be preserved'); };
    recovery.stepOffLeaf = async () => { throw new Error('Do not start another escape during combat'); };
    // Le combat se declare au moment ou la recuperation commence.
    bot.pathfinder.setMovements = () => { bot.pathfinder.movements = defenseMovements; };
    await recovery.run();
    assert.equal(bot.pathfinder.movements, defenseMovements);
    assert.ok(recovery.pending);
    assert.ok(recovery.retryAt > Date.now());
    assert.equal(recovery.running, false);
});

test('a recovery interrupted by another death does not overwrite the new respawn retry', async () => {
    const bot = fakeBot();
    const recovery = new DeathRecovery(bot);
    recovery.onDeath(); recovery.onSpawn();
    recovery.safeMovements = () => {
        bot.entity.position = new Vec3(20, 64, 20);
        recovery.onDeath(); recovery.onSpawn();
        return {};
    };
    await recovery.run();
    assert.equal(recovery.retryAt, 0);
    assert.deepEqual(recovery.pending.position, new Vec3(20, 64, 20));
});

test('controller interruption releases recovery running state so it can resume later', async () => {
    const bot = fakeBot();
    bot.pathfinder.goto = () => new Promise(() => {});
    bot.actions = new (require('../src/lib/ActionController'))(bot);
    const recovery = new DeathRecovery(bot);
    recovery.safeMovements = () => ({ safe: true });
    recovery.onDeath(); recovery.onSpawn();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    const work = bot.actions.run('agent', 20, () => recovery.run());
    await new Promise(resolve => setImmediate(resolve));
    bot.actions.acquire('obstacle', 40);
    await work;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recovery.running, false);
    assert.ok(recovery.pending);
});
