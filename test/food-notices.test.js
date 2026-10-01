const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../src/Agent');

test('critical food retries use five seconds without repeating the same chat notice', () => {
    const messages = [];
    const agent = Object.create(Agent.prototype);
    agent.bot = { food: 0, chat: message => messages.push(message) };
    agent.pauseFoodSearch("Pas d'animal proche");
    const remaining = agent.foodPauseUntil - Date.now();
    assert.ok(remaining > 4500 && remaining <= 5000);
    agent.pauseFoodSearch("Pas d'animal proche");
    agent.pauseFoodSearch("Pas d'animal proche");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /5 s/);
    assert.doesNotMatch(messages[0], /30 s/);
});

test('normal food retries announce the actual thirty second delay', () => {
    const messages = [];
    const agent = Object.create(Agent.prototype);
    agent.bot = { food: 10, chat: message => messages.push(message) };
    agent.pauseFoodSearch("Pas d'animal proche");
    assert.ok(agent.foodPauseUntil - Date.now() > 29000);
    assert.match(messages[0], /30 s/);
});
