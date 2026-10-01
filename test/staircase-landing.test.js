const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DigDown = require('../src/tasks/DigDown');

test('does not start another stair while falling between two levels', async () => {
    const bot = { version: '1.20.4', entity: { position: new Vec3(0.5, 64.4, 0.5), onGround: false } };
    // Aucun acces a l'inventaire ou au terrain ne doit avoir lieu en plein vol.
    await new DigDown(bot, 20).run();
});

test('finishes a stair only after landing at its center, then records it', async () => {
    let ticks = 0;
    const controls = [];
    const records = [];
    const bot = {
        version: '1.20.4',
        entity: { position: new Vec3(1.15, 64.3, 0.5), onGround: false },
        lookAt: async () => {},
        setControlState: (name, value) => controls.push(value),
        trail: { record: p => records.push(p.clone()) },
        waitForTicks: async () => {
            ticks++;
            bot.entity.position = new Vec3(1.5, ticks === 1 ? 64.1 : 64, 0.5);
            bot.entity.onGround = ticks >= 2;
        }
    };
    await new DigDown(bot, 20).stepInto(new Vec3(1, 64, 0));
    assert.equal(ticks, 2);
    assert.deepEqual(records, [new Vec3(1.5, 64, 0.5)]);
    assert.equal(controls.at(-1), false);
});

test('a blocked stair stops movement and fails rather than mining from its edge', async () => {
    let forward;
    const bot = {
        version: '1.20.4',
        entity: { position: new Vec3(0.9, 65, 0.5), onGround: true },
        lookAt: async () => {}, waitForTicks: async () => {},
        setControlState: (name, value) => { forward = value; }
    };
    const task = new DigDown(bot, 20);
    await task.stepInto(new Vec3(1, 64, 0));
    assert.equal(task.hasFailed, true);
    assert.equal(forward, false);
});
