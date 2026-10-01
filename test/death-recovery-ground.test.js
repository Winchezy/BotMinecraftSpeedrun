const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const DeathRecovery = require('../src/lib/DeathRecovery');

test('leaf fallback does not issue walking controls on ordinary ground', async () => {
    const bot = {
        entity: { position: new Vec3(13.5, 110, 56.5), onGround: true },
        entities: {},
        blockAt(p) { return { name: p.y === 109 ? 'coarse_dirt' : 'air', boundingBox: p.y === 109 ? 'block' : 'empty' }; },
        lookAt() { throw new Error('unexpected walk'); },
        waitForTicks() { throw new Error('unexpected walk'); },
        setControlState() { throw new Error('unexpected walk'); }
    };
    assert.equal(await new DeathRecovery(bot, { persist: false }).stepOffLeaf(new Vec3(52, 98, -26)), false);
});
