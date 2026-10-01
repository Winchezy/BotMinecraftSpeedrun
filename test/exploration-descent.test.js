const test = require('node:test');
const assert = require('node:assert/strict');
const { safeExplorationProbe } = require('../src/lib/ExplorationSafety');

function slope(hole = false) {
    return { blockAt(point) {
        const top = point.x === 1 ? 62 : 63;
        return point.y <= top && !(hole && point.x === 2)
            ? { name: 'stone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' };
    } };
}

test('probe follows a planned, supported one-block descent', () => {
    const bot = slope();
    const point = { x: 1, y: 64, z: 0 };
    const path = [{ x: 1, y: 63, z: 0 }];
    assert.equal(safeExplorationProbe(bot, point, path), true);
    assert.equal(safeExplorationProbe(bot, point, []), false);
});

test('probe still rejects a descent beside a deep drop', () => {
    assert.equal(safeExplorationProbe(slope(true), { x: 1, y: 64, z: 0 },
        [{ x: 1, y: 63, z: 0 }]), false);
});
