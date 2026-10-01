const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const Agent = require('../src/Agent');

test('failed escape pauses retries until the bot has relocated', async () => {
    const messages = [];
    let decisions = 0;
    const bot = {
        entity: { position: new Vec3(-56, 34, 21) },
        food: 20,
        blockAt: () => ({ name: 'air' }),
        chat: message => messages.push(message)
    };
    const agent = Object.create(Agent.prototype);
    agent.bot = bot;
    agent.deathRecovery = { pending: false };
    agent.currentTask = {
        name: 'DigDown', hasFailed: true, failureReason: 'Vide infranchissable',
        isDone: () => true
    };
    agent.failedTasks = {};
    agent.unsafeDigSite = null;
    agent.decideNext = async () => { decisions++; };

    await agent.tick();
    assert.equal(agent.currentTask.name, 'EscapeCaveLedge');
    assert.equal(agent.failedTasks.DigDown, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /cherche une sortie/);

    agent.currentTask.done = true;
    agent.currentTask.hasFailed = true;
    agent.currentTask.failureReason = 'Aucun trajet stable hors de la grotte';
    await agent.tick();
    assert.equal(agent.currentTask, null);
    assert.match(messages[1], /Sortie impossible/);

    await agent.tick();
    await agent.tick();
    assert.equal(decisions, 0);
    assert.equal(messages.length, 2);

    bot.entity.position = new Vec3(-49, 34, 21);
    await agent.tick();
    assert.equal(decisions, 1);
    assert.equal(agent.unsafeDigSite, null);
    assert.equal(agent.failedTasks.DigDown, 0);
});
