const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { threatNearPath } = require('../src/lib/MobSafety');
const Agent = require('../src/Agent');

test('rejects a path through a skeleton and creeper crowd', () => {
    const bot = { entities: {
        a: { name: 'skeleton', position: new Vec3(9, 64, 0) },
        b: { name: 'creeper', position: new Vec3(10, 64, 2) }
    } };
    const path = [new Vec3(2, 64, 0), new Vec3(4, 64, 0), new Vec3(6, 64, 0)];
    assert.equal(threatNearPath(bot, path)?.name, 'skeleton');
});

test('allows a route separated from mobs by height or distance', () => {
    const bot = { entities: {
        a: { name: 'skeleton', position: new Vec3(9, 40, 0) },
        b: { name: 'creeper', position: new Vec3(40, 64, 40) }
    } };
    assert.equal(threatNearPath(bot, [new Vec3(8, 64, 0)]), null);
});

test('pauses ore retries after mobs block the route', async () => {
    const messages = [];
    const bot = {
        entity: { position: new Vec3(0, 64, 0) }, food: 20,
        blockAt: () => ({ name: 'air' }), chat: message => messages.push(message)
    };
    const agent = Object.create(Agent.prototype);
    agent.bot = bot;
    agent.combatPreparation = new (require('../src/lib/CombatPreparation'))(bot);
    agent.deathRecovery = { pending: false };
    agent.currentTask = {
        name: 'Mine_iron_ore', hasFailed: true,
        failureReason: 'Mobs sur le trajet du minerai', isDone: () => true
    };
    agent.failedTasks = {};
    agent.decideNext = async () => { throw new Error('should remain paused'); };

    await agent.tick();
    assert.equal(agent.currentTask, null);
    assert.ok(agent.mobRoutePauseUntil > Date.now());
    assert.match(messages[0], /mobs/i);
    await agent.tick();
});

test('treats an ore inside a creeper retreat zone as unreachable', () => {
    const { threatNearPoint } = require('../src/lib/MobSafety');
    // Cas observe en jeu : creeper a ~15 blocs du minerai, sous le bot.
    const bot = { entities: { a: { name: 'creeper', position: new Vec3(-6, 49, 36) } } };
    assert.equal(threatNearPoint(bot, new Vec3(-6, 49, 21), 3)?.name, 'creeper');
    assert.equal(threatNearPoint(bot, new Vec3(-6, 49, 0), 3), null);
});

test('uses the lone-zombie radius when the group is far from the point', () => {
    const { threatNearPoint } = require('../src/lib/MobSafety');
    const bot = { entities: {
        a: { name: 'zombie', position: new Vec3(12, 64, 0) },
        b: { name: 'zombie', position: new Vec3(200, 64, 0) }
    } };
    assert.equal(threatNearPoint(bot, new Vec3(0, 64, 0), 3), null);
    assert.equal(threatNearPoint(bot, new Vec3(3, 64, 0), 3)?.name, 'zombie');
});
