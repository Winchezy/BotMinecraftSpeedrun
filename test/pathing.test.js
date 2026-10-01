const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { disableDiagonalMoves, findBlockingStep, findCardinalWaypoint } = require('../src/lib/Pathing');

test('does not plan a diagonal step through a corner', () => {
    const movements = {
        getNeighbors() {
            return [
                { x: 1, y: 0, z: 0 },
                { x: 0, y: 0, z: 1 },
                { x: 1, y: 0, z: 1 }
            ];
        }
    };
    disableDiagonalMoves(movements);
    assert.deepEqual(movements.getNeighbors({ x: 0, y: 0, z: 0 }), [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 }
    ]);
});

function corridor(withWater = false, withFloor = true) {
    return {
        health: 20,
        isInCombat: () => false,
        pathfinder: { movements: { canDig: true } },
        canDigBlock: () => true,
        blockAt(position) {
            if (withWater && position.x === 1 && position.y === 0 && position.z === -1) {
                return { name: 'water', boundingBox: 'empty', position };
            }
            if (position.y === -1 && withFloor) return { name: 'stone', boundingBox: 'block', position };
            if (position.x === 0 && position.y === 0 && position.z === -1) {
                return { name: 'stone', boundingBox: 'block', position };
            }
            return { name: 'air', boundingBox: 'empty', position };
        }
    };
}

test('clears only a supported, dry obstacle in front of a stalled path', () => {
    const position = new Vec3(0.5, 0, 0.5);
    const next = new Vec3(0.5, 1, -0.5);
    assert.deepEqual(findBlockingStep(corridor(), position, next)?.position, new Vec3(0, 0, -1));
    assert.equal(findBlockingStep(corridor(true), position, next), null);
    assert.equal(findBlockingStep(corridor(false, false), position, next), null);
});

test('uses a supported cardinal step before a diagonal climb', () => {
    const bot = {
        blockAt(position) {
            if (position.x === -17 && position.z === -2 && position.y === 71) {
                return { name: 'dirt', boundingBox: 'block' };
            }
            if (position.x === -18 && position.z === -3 && position.y === 71) {
                return { name: 'air', boundingBox: 'empty' };
            }
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    const step = findCardinalWaypoint(bot, new Vec3(-16.5, 71, -2.28), new Vec3(-17.5, 72, -1.5));
    assert.deepEqual(step, new Vec3(-17, 72, -2));
});

test('stop() while idle is consumed now instead of killing the next goto', () => {
    const { makeIdleStopImmediate } = require('../src/lib/Pathing');
    // Imite mineflayer-pathfinder : stop() leve un drapeau consomme par resetPath.
    let flag = false; let stops = 0; const movements = {};
    const pf = {
        movements,
        stop: () => { flag = true; },
        isMoving: () => false, isMining: () => false, isBuilding: () => false,
        setMovements: () => { if (flag) { flag = false; stops++; } }
    };
    const bot = { pathfinder: pf };
    makeIdleStopImmediate(bot);
    bot.pathfinder.stop();
    assert.equal(flag, false);
    assert.equal(stops, 1);
});

test('stop() while walking a path keeps the graceful flag', () => {
    const { makeIdleStopImmediate } = require('../src/lib/Pathing');
    let flag = false; let resets = 0;
    const pf = {
        movements: {}, stop: () => { flag = true; },
        isMoving: () => true, isMining: () => false, isBuilding: () => false,
        setMovements: () => { resets++; }
    };
    const bot = { pathfinder: pf };
    makeIdleStopImmediate(bot);
    bot.pathfinder.stop();
    assert.equal(flag, true);
    assert.equal(resets, 0);
});

test('a graceful stop still pending is consumed before the next goto', () => {
    const { makeIdleStopImmediate } = require('../src/lib/Pathing');
    let flag = false; let stops = 0; let gotoSawFlag = null;
    const pf = {
        movements: {}, stop: () => { flag = true; },
        isMoving: () => true, isMining: () => true, isBuilding: () => false,
        setMovements: () => { if (flag) { flag = false; stops++; } },
        setGoal: () => {}, goto: () => { gotoSawFlag = flag; return Promise.resolve(); }
    };
    const bot = { pathfinder: pf };
    makeIdleStopImmediate(bot);
    bot.pathfinder.stop();          // en plein minage : arret gracieux
    assert.equal(flag, true);
    bot.pathfinder.goto({});        // nouveau trajet immediat
    assert.equal(gotoSawFlag, false);
    assert.equal(stops, 1);
});
