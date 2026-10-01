const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const WheatFarm = require('../src/lib/WheatFarm');

function setup() {
    let now = 1000;
    let items = [];
    let soilName = 'dirt', cropName = 'air', age = 0;
    let dug = 0, planted = 0, meal = 0;
    const position = new Vec3(0,64,0);
    const bot = { entity: { position: new Vec3(2.5,65,0.5) }, entities: {}, time: { isDay: true },
        inventory: { items: () => items }, pathfinder: { stop() {} }, equip: async () => {}, waitForTicks: async () => {},
        isInCombat: () => false, canDigBlock: () => true,
        blockAt: p => ({ name: p.y === 64 ? soilName : cropName, position: p, skyLight: 15, getProperties: () => ({ age }) }),
        dig: async () => { dug++; cropName = 'air'; },
        activateBlock: async block => { if (block.name === 'wheat') meal++; else soilName = 'farmland'; },
        placeBlock: async () => { planted++; cropName = 'wheat'; } };
    const farm = new WheatFarm(bot, { persist: false, now: () => now });
    farm.approach = async () => true;
    return { bot, farm, position, time: n => { now = n; }, items: value => { items = value; },
        crop: (name, a = 0) => { cropName = name; age = a; },
        counts: () => ({ dug, planted, meal, soilName }) };
}

test('last resort starts only after prolonged absence and the timer survives task retries', async () => {
    const s = setup(); let searches = 0;
    s.farm.collectSeeds = async () => { searches++; return true; };
    assert.equal(await s.farm.run(), false);
    s.time(120000);
    assert.equal(await s.farm.run(), false);
    s.time(121001);
    assert.equal(await s.farm.run(), true);
    assert.equal(searches, 1);
    s.farm.foodFound();
    s.time(122000);
    assert.equal(await s.farm.run(), false);
});

test('immature wheat is never harvested and bone meal is applied when available', async () => {
    const s = setup(); s.crop('wheat', 3);
    assert.equal(await s.farm.tend(s.position), false);
    assert.equal(s.counts().dug, 0);
    s.items([{ name: 'bone_meal', count: 3 }]);
    assert.equal(await s.farm.tend(s.position), true);
    assert.equal(s.counts().meal, 1);
    assert.equal(s.counts().dug, 0);
});

test('mature wheat is harvested and its empty plot can be replanted', async () => {
    const s = setup(); s.crop('wheat', 7);
    assert.equal(await s.farm.tend(s.position), true);
    assert.equal(s.counts().dug, 1);
    s.items([{ name: 'stone_hoe', count: 1 }, { name: 'wheat_seeds', count: 2 }]);
    s.farm.irrigated = () => true;
    assert.equal(await s.farm.tend(s.position), true);
    assert.equal(s.counts().soilName, 'farmland');
    assert.equal(s.counts().planted, 1);
});

test('danger interrupts farming and low light prevents planting', async () => {
    const s = setup(); s.crop('wheat',7);
    s.bot.isInCombat = () => true;
    assert.equal(await s.farm.tend(s.position), false);
    assert.equal(s.counts().dug, 0);
    s.bot.isInCombat = () => false;
    s.crop('air'); s.items([{name:'wheat_seeds',count:1}]);
    s.farm.illuminated = () => false;
    assert.equal(await s.farm.tend(s.position), false);
    assert.equal(s.counts().planted, 0);
});

test('natural growth returns control to food exploration instead of waiting motionless', async () => {
    const s = setup(); s.crop('wheat',3);
    s.farm.noteMissing(); s.time(121001);
    s.farm.state().plots = [s.position, s.position.offset(1,0,0), s.position.offset(2,0,0)];
    assert.equal(await s.farm.run(), false);
    assert.equal(s.counts().dug, 0);
});

test('exploration keeps planted fields nearby while allowing a return from farther away', () => {
    const s = setup();
    s.farm.state().plots = [s.position];
    assert.equal(s.farm.explorationAllowed(new Vec3(15,65,0)),true);
    assert.equal(s.farm.explorationAllowed(new Vec3(60,65,0)),false);
    s.bot.entity.position = new Vec3(80,65,0);
    assert.equal(s.farm.explorationAllowed(new Vec3(60,65,0)),true);
});

test('field access follows a safe route and restores navigation settings', async () => {
    const s = setup();
    const original = {};
    s.bot.registry = require('minecraft-data')('1.20.4');
    const blockAt = s.bot.blockAt;
    s.bot.blockAt = p => ({ ...blockAt(p), boundingBox: p.y <= 64 ? 'block' : 'empty' });
    s.bot.pathfinder.movements = original;
    s.bot.pathfinder.setMovements = value => { s.bot.pathfinder.movements = value; };
    s.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'success', path: [new Vec3(2,65,0)] } }; };
    let reached = false;
    s.bot.pathfinder.goto = async () => { reached = true; };
    s.farm.approach = WheatFarm.prototype.approach.bind(s.farm);
    assert.equal(await s.farm.approach(s.position),true);
    assert.equal(reached,true);
    assert.equal(s.bot.pathfinder.movements,original);
});
