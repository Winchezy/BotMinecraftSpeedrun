const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Supervisor, candidateChanges, issueKey, improved } = require('../tools/autopilot.cjs');

function report() {
    return { generatedAt: new Date().toISOString(), deaths: 0,
        current: { stage: 'EARLY_GAME', task: 'GetWood', inventory: {}, recovery: false },
        window: { seconds: 59, travelled: 0 },
        alerts: [{ code: 'NO_TASK_PROGRESS' }, { code: 'STATIONARY' }] };
}

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-autopilot-'));
    t.after(() => {
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'src', 'movement.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(root, 'test', 'existing.test.js'), '// existing test');
    for (const name of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(root, name), '{}');
    fs.writeFileSync(path.join(root, 'index.js'), '// launcher');
    const supervisor = new Supervisor({ root, dir: path.join(root, '.bot-state', 'autopilot'),
        runTests: async () => ({ code: 0 }), runRepair: async candidate => {
            fs.writeFileSync(path.join(candidate, 'src', 'movement.js'), 'module.exports = 2;');
            fs.writeFileSync(path.join(candidate, 'result.json'), JSON.stringify({ status: 'fixed', cause: 'movement blocked', summary: 'fix movement' }));
            return { code: 0 };
        }, ...options });
    supervisor.stopBot = async () => {};
    supervisor.startBot = () => { supervisor.bot = { pid: 123 }; supervisor.botStartedAt = Date.now(); };
    return { root, supervisor, source: path.join(root, 'src', 'movement.js') };
}

test('autopilot requires mature reports with objective stagnation and preserves progress evidence', () => {
    const r = report();
    assert.equal(issueKey(r), 'EARLY_GAME:GetWood');
    assert.equal(issueKey({ ...r, window: { seconds: 30 } }), null);
    assert.equal(issueKey({ ...r, alerts: [{ code: 'LOW_HEALTH' }] }), null);
    assert.equal(improved(r, { ...r, current: { ...r.current, inventory: { spruce_log: 3 } } }), true);
    assert.equal(improved(r, { ...r, deaths: 1, current: { ...r.current, inventory: { spruce_log: 3 } } }), false);
    assert.equal(improved(r, r), false);
});

test('Codex invocation uses exec-specific flags after exec and retains the sandbox', async t => {
    const { supervisor } = fixture(t);
    let captured;
    supervisor.command = async (...args) => { captured = args; return { code: 0 }; };
    await supervisor.codex('candidate', 'log', 'prompt');
    const args = captured[1];
    assert.equal(args[1], 'exec');
    assert.ok(args.indexOf('--ignore-user-config') > args.indexOf('exec'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol');
    assert.ok(args.includes('windows.sandbox="elevated"'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(captured[4], 'prompt');
});

test('candidate gate rejects deletion, observer changes and existing test rewrites', () => {
    const src = path.join('src', 'movement.js');
    const existing = path.join('test', 'existing.test.js');
    const baseline = new Map([[src, Buffer.from('old')], [existing, Buffer.from('test')]]);
    assert.throws(() => candidateChanges(baseline, new Map([[src, Buffer.from('new')]])), /Suppression/);
    assert.throws(() => candidateChanges(baseline, new Map([[src, Buffer.from('old')], [existing, Buffer.from('disabled')]])), /non autorisee/);
    const observer = path.join('src', 'lib', 'BehaviorObserver.js');
    assert.throws(() => candidateChanges(new Map([[observer, Buffer.from('old')]]), new Map([[observer, Buffer.from('new')]])), /non autorisee/);
});

test('tested correction is applied and can restore the exact previous uncommitted contents', async t => {
    const { source, supervisor } = fixture(t);
    await supervisor.repair(report());
    assert.equal(fs.readFileSync(source, 'utf8'), 'module.exports = 2;');
    assert.equal(supervisor.state.phase, 'validating');
    await supervisor.rollback();
    assert.equal(fs.readFileSync(source, 'utf8'), 'module.exports = 1;');
    assert.equal(supervisor.state.phase, 'rolled_back');
});

test('failed tests leave the live source intact', async t => {
    const { source, supervisor } = fixture(t, { runTests: async () => ({ code: 1 }) });
    await assert.rejects(supervisor.repair(report()), /Tests echoues/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'module.exports = 1;');
    assert.equal(supervisor.deployment, undefined);
});

test('an external edit during correction prevents deployment', async t => {
    const s = fixture(t);
    const repair = s.supervisor.runRepair;
    s.supervisor.runRepair = async (...args) => {
        const result = await repair(...args);
        fs.writeFileSync(s.source, 'external edit');
        return result;
    };
    await assert.rejects(s.supervisor.repair(report()), /Edition concurrente/);
    assert.equal(fs.readFileSync(s.source, 'utf8'), 'external edit');
});

test('repeated reads of the same report do not trigger repair and only persistent reports do', async t => {
    const s = fixture(t);
    s.supervisor.botStartedAt = Date.now() - 10000;
    s.supervisor.bot = { pid: 123 };
    fs.mkdirSync(path.dirname(s.supervisor.reportFile), { recursive: true });
    let calls = 0;
    s.supervisor.repair = async () => { calls++; };
    const base = Date.now() - 4000;
    for (let i = 0; i < 3; i++) {
        fs.writeFileSync(s.supervisor.reportFile, JSON.stringify({ ...report(), generatedAt: new Date(base + i * 1000).toISOString() }));
        await s.supervisor.tick();
        await s.supervisor.tick();
    }
    assert.equal(calls, 1);
});
