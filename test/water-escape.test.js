const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const WaterEscape = require('../src/lib/WaterEscape');

test('searches dry ground with position checks after palette matching, including underground', () => {
    const point = new Vec3(0, 30, 0);
    const bot = { findBlocks: options => {
        assert.equal(options.matching({ name: 'stone', boundingBox: 'block', position: null }), true);
        assert.equal(options.useExtraInfo({ position: point }), true);
        return [point];
    }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
    assert.deepEqual(new WaterEscape(bot).dryFloors(), [point]);
});

test('does not run a second water escape while one is pending', async () => {
    const escape = new WaterEscape({});
    escape.busy = true;
    await escape.tick(true);
    assert.equal(escape.busy, true);
});

test('clears swimming controls after reaching dry ground', async () => {
    let cleared = false;
    const escape = new WaterEscape({ clearControlStates: () => { cleared = true; } });
    escape.active = true;
    await escape.tick(false);
    assert.equal(cleared, true);
    assert.equal(escape.active, false);
});
