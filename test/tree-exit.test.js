const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DeathRecovery = require('../src/lib/DeathRecovery');

function canopy(supported, trunkEntrance = false) {
    const blocks = new Map([
        [new Vec3(0, 79, 0).toString(), 'spruce_leaves'],
        [new Vec3(1, 80, 0).toString(), 'spruce_leaves'],
        [new Vec3(1, 81, 0).toString(), 'spruce_leaves']
    ]);
    if (supported) blocks.set(new Vec3(1, 79, 0).toString(), 'spruce_log');
    if (trunkEntrance) {
        blocks.set(new Vec3(1, 80, 0).toString(), 'spruce_log');
        blocks.set(new Vec3(1, 81, 0).toString(), 'spruce_log');
    }
    const dug = [];
    const bot = {
        version: '1.20.4', registry: require('minecraft-data')('1.20.4'), entities: {},
        entity: { position: new Vec3(0.5, 80, 0.5) }, game: { dimension: 'overworld' },
        blockAt: p => { const name = blocks.get(p.floored().toString()) || 'air';
            return { position: p.floored(), name, boundingBox: name === 'air' ? 'empty' : 'block' }; },
        canDigBlock: () => true, clearControlStates() {},
        dig: async block => { dug.push(block.position.clone()); blocks.delete(block.position.toString()); },
        pathfinder: {
            movements: {}, setGoal() {}, setMovements(m) { this.movements = m; },
            *getPathFromTo() { yield { result: { status: 'success', path: [new Vec3(1, 80, 0)] } }; },
            goto: async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }
        }
    };
    const recovery = new DeathRecovery(bot);
    recovery.pending = { position: new Vec3(10, 64, 0) };
    return { bot, recovery, dug };
}

test('opens only lateral leaves to reach a supported trunk without breaking the current floor', async () => {
    const { bot, recovery, dug } = canopy(true);
    assert.equal(await recovery.openTreeExit(recovery.pending.position, 0), true);
    assert.deepEqual(dug, [new Vec3(1, 80, 0), new Vec3(1, 81, 0)]);
    assert.equal(bot.blockAt(new Vec3(0, 79, 0)).name, 'spruce_leaves');
    assert.equal(bot.blockAt(new Vec3(1, 79, 0)).name, 'spruce_log');
    assert.equal(bot.entity.position.x, 1.5);
});

test('does not open leaves that lead into an unsupported drop', async () => {
    const { recovery, dug } = canopy(false);
    assert.equal(await recovery.openTreeExit(recovery.pending.position, 0), false);
    assert.deepEqual(dug, []);
});

test('can enter a trunk by clearing body and head logs while preserving its landing support', async () => {
    const { bot, recovery, dug } = canopy(true, true);
    assert.equal(await recovery.openTreeExit(recovery.pending.position, 0), true);
    assert.equal(dug.length, 2);
    assert.equal(bot.blockAt(new Vec3(1, 79, 0)).name, 'spruce_log');
});
