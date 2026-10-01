const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const Agent = require('../src/Agent');
const { portalLayout, findPortalSite } = require('../src/tasks/BuildNetherPortal');
const { findPourSpot, findStandSpot } = require('../src/tasks/MakeObsidian');

// Monde plat : pierre jusqu'a y=63, air au-dessus ; `overrides` pour les cas particuliers.
function flatWorld(overrides = {}, botPos = new Vec3(0.5, 64, 0.5)) {
    const blockAt = (pos) => {
        const p = pos.floored();
        const name = overrides[p.toString()] || (p.y <= 63 ? 'stone' : 'air');
        return {
            name, position: p, metadata: 0,
            boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block'
        };
    };
    return { blockAt, entity: { position: botPos } };
}

test('portal layout uses exactly 10 obsidian and supports every block', () => {
    const layout = portalLayout(new Vec3(0, 64, 0), new Vec3(1, 0, 0));
    assert.equal(layout.obsidian.length, 10);
    assert.equal(layout.order.filter(([k]) => k === 'obsidian').length, 10);
    // Chaque bloc pose touche un bloc deja pose ou le sol.
    const placed = new Set(layout.ground.map(p => p.toString()));
    const dirs = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    for (const [, p] of layout.order) {
        assert.ok(dirs.some(([x, y, z]) => placed.has(p.offset(x, y, z).toString())), `pas de soutien pour ${p}`);
        placed.add(p.toString());
    }
    // L'interieur (2x3) reste vide.
    for (const p of layout.interior) assert.ok(!layout.obsidian.some(o => o.equals(p)));
});

test('finds a buildable portal site on flat ground, bot not inside the frame', () => {
    const bot = flatWorld();
    const site = findPortalSite(bot);
    assert.ok(site);
    assert.equal(site.toDig, 0);
    const volume = [...site.layout.obsidian, ...site.layout.interior];
    assert.ok(!volume.some(p => p.equals(site.stand)));
    for (const p of site.layout.obsidian) {
        assert.ok(p.offset(0.5, 0.5, 0.5).distanceTo(site.stand.offset(0.5, 1.62, 0.5)) < 6);
    }
});

test('never picks a portal site with a liquid in the frame', () => {
    const overrides = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 64; y <= 68; y++) overrides[`(${x}, ${y}, ${z})`] = 'water';
    assert.equal(findPortalSite(flatWorld(overrides)), null);
});

test('pours water in an air cell beside the lava source, on solid floor', () => {
    const lava = new Vec3(3, 64, 0);
    const bot = flatWorld({ [lava.toString()]: 'lava' });
    const pour = findPourSpot(bot, lava);
    assert.ok(pour);
    assert.equal(pour.y, lava.y);
    assert.equal(pour.distanceTo(lava), 1);
    assert.equal(bot.blockAt(pour.offset(0, -1, 0)).name, 'stone');
});

test('lava pool sunk in the ground: pours on the rim, one block up', () => {
    const lava = new Vec3(3, 63, 0); // affleure au niveau du sol, bord solide
    const bot = flatWorld({ [lava.toString()]: 'lava' });
    const pour = findPourSpot(bot, lava);
    assert.ok(pour);
    assert.equal(pour.y, lava.y + 1);
    assert.equal(Math.hypot(pour.x - lava.x, pour.z - lava.z), 1);
    assert.ok(findStandSpot(bot, pour, lava));
});

test('lava pool behind a one-block wall: pours on top of the wall', () => {
    // Mare au fond d'une fosse : muret de pierre au niveau de la lave et au-dessus.
    const lava = new Vec3(3, 63, 0);
    const bot = flatWorld({ [lava.toString()]: 'lava', '(3, 64, 0)': 'air', '(3, 65, 0)': 'air' }, new Vec3(0.5, 65, 0.5));
    const walled = { ...Object.fromEntries([[2, 0], [4, 0], [3, 1], [3, -1]].map(([x, z]) => [`(${x}, 64, ${z})`, 'stone'])) };
    const bot2 = flatWorld({ [lava.toString()]: 'lava', ...walled }, new Vec3(0.5, 65, 0.5));
    const pour = findPourSpot(bot2, lava);
    assert.ok(pour);
    assert.equal(pour.y, lava.y + 2);
    assert.ok(bot); // (monde de reference sans muret)
});

test('no pour spot for lava sealed in stone', () => {
    const lava = new Vec3(3, 60, 0);
    assert.equal(findPourSpot(flatWorld({ [lava.toString()]: 'lava' }), lava), null);
});

test('stand spot is reachable, not in the pour cell, not next to lava', () => {
    // Lave au niveau du sol (y=64), bordee de sol ; eau versee a cote.
    const lava = new Vec3(4, 64, 0);
    const bot = flatWorld({ [lava.toString()]: 'lava' });
    const pour = findPourSpot(bot, lava);
    assert.ok(pour);
    const stand = findStandSpot(bot, pour, lava);
    assert.ok(stand);
    assert.ok(!stand.equals(pour));
    assert.ok(stand.offset(0.5, 1.62, 0.5).distanceTo(pour.offset(0.5, 0, 0.5)) <= 4.3);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        assert.notEqual(bot.blockAt(stand.offset(x, y, z)).name, 'lava');
    }
});

// ---- Decisions de l'Agent a l'etape NETHER ----
function netherAgent(items, { portal = false } = {}) {
    const agent = Object.create(Agent.prototype);
    agent.mcData = require('minecraft-data')('1.20.4');
    agent.failedTasks = {};
    agent.bot = {
        version: '1.20.4', entity: { position: new Vec3(0, 40, 0) },
        findBlock: () => (portal ? { position: new Vec3(0, 40, 3) } : null)
    };
    agent.ensureTable = async () => { };
    const inv = items.map(([name, n]) => ({ name, count: n }));
    const count = name => inv.filter(i => i.name.includes(name)).reduce((a, i) => a + i.count, 0);
    const has = name => inv.some(i => i.name.includes(name));
    return { agent, inv, has, count };
}

test('nether stage without diamond pickaxe falls back to gear recovery', async () => {
    const { agent, inv, has, count } = netherAgent([['dirt', 10]]);
    let recovered = false;
    agent.handleDiamondStage = async () => { recovered = true; };
    await agent.handleNetherStage(inv, has, count);
    assert.ok(recovered);
});

test('nether stage crafts a bucket before trying to make obsidian', async () => {
    const { agent, inv, has, count } = netherAgent([['diamond_pickaxe', 1], ['iron_ingot', 4], ['flint_and_steel', 1]]);
    await agent.handleNetherStage(inv, has, count);
    assert.equal(agent.currentTask.name, 'Craft_bucket');
});

test('a water bucket counts as a bucket (no "bucket" substring trap)', async () => {
    const { agent, inv, has, count } = netherAgent([['diamond_pickaxe', 1], ['water_bucket', 1], ['flint_and_steel', 1]]);
    await agent.handleNetherStage(inv, has, count);
    assert.equal(agent.currentTask.name, 'MakeObsidian');
});

test('empty bucket gets filled with water first', async () => {
    const { agent, inv, has, count } = netherAgent([['diamond_pickaxe', 1], ['bucket', 1], ['flint_and_steel', 1]]);
    await agent.handleNetherStage(inv, has, count);
    assert.equal(agent.currentTask.name, 'FillBucket');
});

test('gravel target grows so flint hunting cannot complete without flint', async () => {
    const { agent, inv, has, count } = netherAgent([['diamond_pickaxe', 1], ['obsidian', 10], ['gravel', 7], ['iron_ingot', 1]]);
    await agent.handleNetherStage(inv, has, count);
    assert.equal(agent.currentTask.name, 'Mine_gravel');
    assert.equal(agent.currentTask.count, 10);
});

test('with obsidian and flint and steel, builds the portal', async () => {
    const { agent, inv, has, count } = netherAgent([['diamond_pickaxe', 1], ['obsidian', 10], ['flint_and_steel', 1]]);
    await agent.handleNetherStage(inv, has, count);
    assert.equal(agent.currentTask.name, 'BuildNetherPortal');
});
