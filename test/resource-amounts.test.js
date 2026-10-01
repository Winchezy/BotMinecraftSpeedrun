const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLimitingResource, craftBatch, getFuelSmeltOutput } = require('../src/lib/ResourceAmounts');
const CraftTask = require('../src/tasks/CraftTask');

test('missing ingredients and split stacks limit crafting batches', () => {
    assert.equal(calculateLimitingResource({stone: 9}, {stone: 3, stick: 2}).num, 0);
    const bot = { inventory: { items: () => [{type: 1, count: 2}, {type: 1, count: 4}] } };
    const recipe = { delta: [{id: 1, count: -2}, {id: 2, count: 4}], result: {count: 4} };
    assert.equal(craftBatch(bot, recipe, 5), 2);
    assert.equal(craftBatch(bot, recipe, 20), 3);
});

test('real Mineflayer recipes craft only the missing output in batches', async () => {
    const data = require('minecraft-data')('1.20.4');
    const recipes = require('prismarine-recipe')('1.20.4').Recipe;
    const plank = data.itemsByName.oak_planks.id, stick = data.itemsByName.stick.id;
    const recipe = recipes.find(stick, null).find(r => r.delta.some(i => i.id === plank && i.count < 0));
    const items = [{name: 'oak_planks', type: plank, count: 6}, {name: 'stick', type: stick, count: 2}];
    let calls = 0;
    const bot = { version: '1.20.4', inventory: {items: () => items}, recipesFor: () => [recipe],
        craft: async (r, batches) => {
            calls++;
            assert.equal(batches, 2);
            items[0].count -= 4;
            items[1].count += 8;
        } };
    const task = new CraftTask(bot, 'stick', 9);
    await task.run();
    await task.run();
    assert.equal(calls, 1);
    assert.equal(task.isDone(), true);
    assert.equal(task.hasFailed, false);
});

test('fuel dosing preserves surplus coal and supports fractional wood capacity', () => {
    assert.equal(Math.ceil(1 / getFuelSmeltOutput('coal')), 1);
    assert.equal(Math.ceil(9 / getFuelSmeltOutput('coal')), 2);
    assert.equal(Math.ceil(3 / getFuelSmeltOutput('oak_planks')), 2);
    assert.equal(Math.ceil(1 / getFuelSmeltOutput('stick')), 2);
    assert.equal(getFuelSmeltOutput('diamond'), 0);
});
