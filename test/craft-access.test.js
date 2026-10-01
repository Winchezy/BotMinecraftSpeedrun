const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const CraftTask = require('../src/tasks/CraftTask');

test('a rejected crafting table stays excluded across crafting tasks', () => {
    const bot = { version: '1.20.4', entities: {} };
    const table = { position: new Vec3(38, 44, 7) };
    new CraftTask(bot, 'iron_pickaxe').rejectTable(table);
    assert.equal(CraftTask.usableTable(bot, table), false);
    assert.equal(CraftTask.usableTable(bot, { position: new Vec3(38, 52, 7) }), true);
});

test('crafts using a visible nearby table without starting a distant path', async () => {
    const items = [];
    const table = { position: new Vec3(1, 64, 0) };
    const bot = { version: '1.20.4', entities: {}, entity: { position: new Vec3(0, 64, 0) },
        inventory: { items: () => items }, findBlock: () => table,
        canSeeBlock: () => true, recipesFor: (id, metadata, count, craftingTable) => craftingTable ? [{}] : [],
        craft: async (recipe, count, craftingTable) => {
            assert.equal(craftingTable, table);
            items.push({ name: 'iron_pickaxe', count: 1 });
        } };
    const task = new CraftTask(bot, 'iron_pickaxe');
    await task.run();
    await task.run();
    assert.equal(task.isDone(), true);
    assert.equal(task.hasFailed, false);
});
