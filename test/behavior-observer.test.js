const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Observer = require('../src/lib/BehaviorObserver');

function setup() {
    let time = 100000;
    let items = [];
    const bot = Object.assign(new EventEmitter(), {
        username: 'TestBot', entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { items: () => items }, actions: { current: { owner: 'agent' } },
        health: 20, food: 20, game: { dimension: 'overworld' }
    });
    const agent = { stage: 'EARLY_GAME', currentTask: { name: 'GetWood' } };
    const observer = new Observer(bot, agent, { start: false, now: () => time });
    return { bot, agent, observer, step: () => { time += 1000; observer.sample(); }, items: value => { items = value; } };
}

test('observer distinguishes stationary stagnation from inventory progress', () => {
    const s = setup();
    for (let i = 0; i < 61; i++) s.step();
    assert.ok(s.observer.report().alerts.some(a => a.code === 'STATIONARY'));
    s.items([{ name: 'spruce_log', count: 2 }]);
    s.step();
    assert.ok(!s.observer.report().alerts.some(a => a.code === 'NO_TASK_PROGRESS'));
});

test('observer detects local movement loops and repeated survival interruptions', () => {
    const s = setup();
    for (let i = 0; i < 61; i++) {
        s.bot.entity.position.x = i % 4;
        s.bot.actions.current.owner = i % 2 ? 'combat' : 'agent';
        s.step();
    }
    const report = s.observer.report();
    assert.ok(report.alerts.some(a => a.code === 'LOCAL_LOOP'));
    assert.ok(report.alerts.some(a => a.code === 'SURVIVAL_DOMINATES'));
});

test('observer records death evidence and writes bounded current reports', () => {
    const s = setup();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-observer-'));
    s.observer.directory = directory;
    try {
        s.items([{ name: 'stone_pickaxe', count: 1 }]);
        s.step();
        s.bot.emit('death');
        s.bot.food = 0;
        s.bot.health = 4;
        s.step();
        s.observer.writeReport();
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'TestBot.json'), 'utf8'));
        assert.equal(saved.deaths, 1);
        assert.equal(saved.events.find(e => e.type === 'death').inventory.stone_pickaxe, 1);
        assert.ok(saved.alerts.some(a => a.code === 'LOW_FOOD'));
        assert.ok(fs.readFileSync(path.join(directory, 'TestBot.txt'), 'utf8').includes('GetWood'));
        s.observer.stop();
        assert.equal(s.bot.listenerCount('death'), 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
