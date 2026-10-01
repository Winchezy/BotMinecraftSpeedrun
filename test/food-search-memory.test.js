const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const FoodSearchMemory = require('../src/lib/FoodSearchMemory');

const origin = new Vec3(0,64,0);
const target = new Vec3(24,64,0);

test('avoids recently explored zones but allows visible food there', () => {
    const memory = new FoodSearchMemory({});
    memory.markVisited(target, 1000);
    assert.equal(memory.allowed(origin, target, true, 2000), false);
    assert.equal(memory.allowed(origin, target, false, 2000), true);
    assert.equal(memory.allowed(origin, target, true, 61001), true);
});

test('reconsiders a failed route after moving to another approach or after expiry', () => {
    const memory = new FoodSearchMemory({});
    memory.markBlocked(origin, target, 'noPath', 1000);
    assert.equal(memory.allowed(origin, target, true, 2000), false);
    assert.equal(memory.allowed(new Vec3(16,64,16), target, true, 2000), true);
    assert.equal(memory.allowed(origin, target, true, 122000), true);
});

test('serialized memory preserves failed destinations', () => {
    const memory = new FoodSearchMemory({});
    memory.markBlocked(origin,target,'noPath',1000);
    const restored = new FoodSearchMemory({});
    restored.entries = new Map(JSON.parse(JSON.stringify([...memory.entries])));
    assert.equal(restored.allowed(origin,target,true,2000),false);
});

test('bounds food memory to prevent indefinite accumulation', () => {
    const memory = new FoodSearchMemory({});
    for (let i=0;i<600;i++) memory.markVisited(new Vec3(i*8,64,0),1000);
    assert.equal(memory.entries.size,512);
});
