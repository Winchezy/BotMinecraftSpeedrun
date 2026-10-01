const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const GetFood = require('../src/tasks/GetFood');

test('food exploration can leave its current cell through a safe adjacent passage', async () => {
    let moves = 0;
    const bot = {
        registry: require('minecraft-data')('1.20.4'),
        entity: { position: new Vec3(0.5,64,0.5) }, entities: {},
        inventory: { items: () => [] }, clearControlStates() {},
        blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
        pathfinder: {
            movements: {}, setMovements(value) { this.movements = value; },
            getPathFromTo: function* (movements, start, goal) {
                const nearby = Math.hypot(goal.x,goal.z) <= 1.5;
                yield { result: { status: nearby ? 'success' : 'noPath', path: nearby ? [new Vec3(goal.x,goal.y,goal.z)] : [] } };
            },
            goto: async goal => { moves++; bot.entity.position = new Vec3(goal.x+0.5,goal.y,goal.z+0.5); }
        }
    };
    const task = Object.create(GetFood.prototype);
    task.bot = bot;
    task.memory = { allowed: () => true };
    task.watchForFood = () => ({ promise: new Promise(() => {}), stop() {} });
    assert.equal(await task.exploreNearbyGround(), true);
    assert.equal(moves, 1);
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5,64,0.5)) >= 1);
});
