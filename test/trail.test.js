const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Trail } = require('../src/lib/Trail');

// Escalier type DigDown : 1 bloc en avant, 1 bloc plus bas a chaque marche.
function descend(trail, from, steps) {
    for (let i = 1; i <= steps; i++) trail.record(from.offset(0, -i, i), false);
}

test('records the staircase dug down from the surface entry point', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 70, 0), true);
    descend(trail, new Vec3(0, 70, 0), 20);
    assert.deepEqual(trail.points[0], new Vec3(0, 70, 0));
    assert.ok(trail.points.length >= 10);
    assert.equal(trail.points.at(-1).y, 50);
});

test('walks the trail back toward the surface, never away from it', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 70, 0), true);
    descend(trail, new Vec3(0, 70, 0), 20);
    const w = trail.nextWaypoint(new Vec3(0, 50, 20));
    assert.ok(w.point.y > 50);
    assert.ok(w.index < trail.points.length - 1);
    assert.equal(trail.nextWaypoint(new Vec3(0, 69, 1)).index, 0);
});

test('cuts detours when the bot comes back to an earlier point', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 70, 0), true);
    descend(trail, new Vec3(0, 70, 0), 6);
    const beforeDetour = trail.points.length;
    // Detour dans une galerie puis retour au bas de l'escalier.
    for (let x = 2; x <= 10; x += 2) trail.record(new Vec3(x, 64, 6), false);
    trail.record(new Vec3(0, 64, 6), false);
    assert.equal(trail.points.length, beforeDetour);
});

test('ignores movement when no surface anchor exists', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 30, 0), false);
    trail.record(new Vec3(5, 30, 0), false);
    assert.equal(trail.points.length, 0);
    assert.equal(trail.nextWaypoint(new Vec3(0, 30, 0)), null);
});

test('surfacing again resets the trail to the new entry point', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 70, 0), true);
    descend(trail, new Vec3(0, 70, 0), 10);
    trail.record(new Vec3(40, 72, 40), true);
    assert.deepEqual(trail.points, [new Vec3(40, 72, 40)]);
});

test('drops the trail after a fall the bot cannot climb back', () => {
    const trail = new Trail();
    trail.record(new Vec3(0, 70, 0), true);
    descend(trail, new Vec3(0, 70, 0), 6);
    trail.record(new Vec3(0, 50, 7), false); // chute de 14 blocs dans une grotte
    assert.equal(trail.points.length, 0);
});
