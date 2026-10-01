const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DigDown = require('../src/tasks/DigDown');

test('uses the requested stage ore instead of always searching for diamonds', () => {
    const bot = { version: '1.20.4' };
    assert.equal(new DigDown(bot, 54).oreName, 'iron_ore');
    assert.equal(new DigDown(bot, -54).oreName, 'diamond_ore');
    assert.equal(new DigDown(bot, 20, 'coal_ore').oreName, 'coal_ore');
});

test('tries the cave before equipping a pickaxe and digging a new descent', async () => {
    let searched = false;
    const bot = { version: '1.20.4', entities: {}, entity: { position: new Vec3(0, 70, 0) },
        inventory: { items: () => [{ name: 'stone_pickaxe', maxDurability: 131 }] },
        findBlock: () => null, equip: async () => { throw new Error('Must explore the cave first'); } };
    const task = new DigDown(bot, 54);
    task.followCave = async ids => {
        searched = true;
        assert.ok(ids.includes(task.mcData.blocksByName.iron_ore.id));
        assert.ok(!ids.includes(task.mcData.blocksByName.diamond_ore.id));
        return true;
    };
    await task.run();
    assert.equal(searched, true);
});
