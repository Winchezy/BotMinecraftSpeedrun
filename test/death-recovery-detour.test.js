const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DeathRecovery = require('../src/lib/DeathRecovery');

test('recovery tries a safe detour when only the proposed waypoint is near a mob', async () => {
    const start = new Vec3(0.5, 64, 0.5);
    const death = new Vec3(30.5, 64, 0.5);
    const detour = new Vec3(4.5, 64, -5.5);
    const bot = {
        entity: { position: start }, game: { dimension: 'overworld' },
        entities: { 1: { name: 'zombie', position: new Vec3(12.5, 64, 0.5) } },
        pathfinder: { movements: {}, setMovements(value) { this.movements = value; } },
        blockAt: () => ({ name: 'stone', boundingBox: 'block' })
    };
    const recovery = new DeathRecovery(bot, { persist: false });
    recovery.pending = { position: death, dimension: 'overworld' };
    recovery.ready = true;
    recovery.safeMovements = () => ({});
    recovery.safeCellNear = () => new Vec3(12.5, 64, 0.5);
    recovery.findWaypoint = async () => detour;
    let movedTo;
    recovery.moveTo = async target => { movedTo = target; throw new Error('test stop'); };
    await recovery.run();
    assert.deepEqual(movedTo, detour);
});
