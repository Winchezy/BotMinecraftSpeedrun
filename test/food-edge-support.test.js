const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { supportExplorationEdge } = require('../src/lib/ExplorationSafety');

function setup() {
    const placed = new Set();
    const bot = { entity: { position: new Vec3(-1.5,64,0.5) }, entities: {},
        inventory: { items: () => [{ name: 'cobblestone', count: 2 }] },
        pathfinder: { setGoal() {}, stop() {} }, clearControlStates() {}, equip: async () => {},
        blockAt: p => {
            const solid = placed.has(p.toString()) || p.y < 64 && p.x !== 1;
            return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p };
        }, placeBlock: async (ref, face) => placed.add(ref.position.plus(face).toString()) };
    return { bot, placed };
}

test('fills a lateral margin from solid ground and verifies the placed support', async () => {
    const { bot, placed } = setup();
    assert.equal(await supportExplorationEdge(bot,new Vec3(0,64,0)), true);
    assert.ok(placed.has(new Vec3(1,63,0).toString()));
});

test('never creates an exploration floor over a missing central support', async () => {
    const { bot, placed } = setup();
    assert.equal(await supportExplorationEdge(bot,new Vec3(1,64,0)), false);
    assert.equal(placed.size, 0);
});

test('does not place beside lava and does not report success without a confirmed block', async () => {
    const { bot } = setup();
    const original = bot.blockAt;
    bot.blockAt = p => p.x === 1 && p.y === 62 ? { name: 'lava', boundingBox: 'empty', position: p } : original(p);
    assert.equal(await supportExplorationEdge(bot,new Vec3(0,64,0)), false);
    bot.blockAt = original;
    bot.placeBlock = async () => {};
    assert.equal(await supportExplorationEdge(bot,new Vec3(0,64,0)), false);
});
