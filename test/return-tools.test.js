const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Trail } = require('../src/lib/Trail');
const DigDown = require('../src/tasks/DigDown');

test('restores a saved underground trail after a restart', () => {
    const trail = new Trail();
    trail.restore(JSON.parse(JSON.stringify([new Vec3(0, 70, 0), new Vec3(0, 60, 10)])));
    assert.deepEqual(trail.nextWaypoint(new Vec3(0, 60, 10)).point, new Vec3(0, 70, 0));
});

test('stops descending before exhausting the return pickaxe reserve', async () => {
    const bot = { version: '1.20.4', entity: { position: new Vec3(0, 30, 0) },
        inventory: { items: () => [{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 100 }] } };
    const task = new DigDown(bot, -50);
    await task.run();
    assert.equal(task.failureReason, 'Reserve de pioche pour la remontee');
});
