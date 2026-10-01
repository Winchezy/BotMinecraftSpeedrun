const fs = require('node:fs');
const path = require('node:path');

// Observation passive : aucune commande Minecraft, aucun changement de decision.
class BehaviorObserver {
    constructor(bot, agent, options = {}) {
        this.bot = bot;
        this.agent = agent;
        this.now = options.now || Date.now;
        this.directory = options.directory || path.resolve('.bot-state', 'observer');
        this.samples = [];
        this.events = [];
        this.startedAt = this.now();
        this.deaths = 0;
        this.lastReportAt = 0;
        this.onDeath = () => {
            this.deaths++;
            this.event('death', { position: this.position(), inventory: this.inventory() });
        };
        this.onHurt = entity => {
            if (entity === bot.entity) this.event('damage', { health: bot.health, position: this.position() });
        };
        this.onEnd = () => this.stop();
        bot.on('death', this.onDeath);
        bot.on('entityHurt', this.onHurt);
        bot.once('end', this.onEnd);
        if (options.start !== false) {
            this.timer = setInterval(() => {
                try {
                    this.sample();
                    if (this.now() - this.lastReportAt >= 30000) this.writeReport();
                } catch (error) { console.error(`[Observer] ${error.message}`); }
            }, 1000);
        }
    }

    position() {
        const p = this.bot.entity?.position;
        return p ? { x: p.x, y: p.y, z: p.z } : null;
    }

    inventory() {
        const result = {};
        for (const item of this.bot.inventory?.items() || []) {
            result[item.name] = (result[item.name] || 0) + item.count;
        }
        return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    }

    event(type, details) {
        this.events.push({ time: this.now(), type, ...details });
        if (this.events.length > 200) this.events.shift();
    }

    sample() {
        const position = this.bot.entity?.position;
        const nearbyMobs = Object.values(this.bot.entities || {})
            .filter(e => e.position && e !== this.bot.entity &&
                /zombie|skeleton|creeper|spider|enderman|blaze|ghast|pillager/.test(e.name || '') &&
                position?.distanceTo?.(e.position) <= 20)
            .map(e => ({ id: e.id, name: e.name, position: { x: e.position.x, y: e.position.y, z: e.position.z },
                distance: Math.round(position.distanceTo(e.position) * 10) / 10,
                state: this.bot.mobAwareness?.observations.get(e.id)?.state || 'unknown' }))
            .sort((a, b) => a.distance - b.distance).slice(0, 12);
        const terrain = [];
        if (position?.floored && this.bot.blockAt) {
            const feet = position.floored();
            for (const [x, z] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
                terrain.push({ x, z, blocks: [-2,-1,0,1,2].map(y => {
                    const block = this.bot.blockAt(feet.offset(x,y,z));
                    return block ? { name: block.name, solid: block.boundingBox === 'block' } : null;
                }) });
            }
        }
        const sample = {
            time: this.now(), position: this.position(), stage: this.agent.stage,
            task: this.agent.currentTask?.name || null,
            survivalDecision: this.bot.survivalDecision || null,
            recovery: !!this.agent.deathRecovery?.pending,
            owner: this.bot.actions?.current?.owner || 'idle',
            health: this.bot.health, food: this.bot.food,
            dimension: this.bot.game?.dimension,
            inventory: this.inventory(),
            farming: this.bot.foodFarmingStatus || null,
            digging: !!this.bot.targetDigBlock,
            goal: this.bot.pathfinder?.goal?.constructor?.name || null,
            nearbyMobs, terrain, onGround: this.bot.entity?.onGround,
            retreatTarget: this.bot.retreatTarget ? { x: this.bot.retreatTarget.x, y: this.bot.retreatTarget.y, z: this.bot.retreatTarget.z } : null
        };
        const previous = this.samples.at(-1);
        if (previous && (previous.owner !== sample.owner || previous.task !== sample.task ||
            previous.stage !== sample.stage || previous.recovery !== sample.recovery)) {
            this.event('transition', {
                from: { owner: previous.owner, task: previous.task, stage: previous.stage, recovery: previous.recovery },
                to: { owner: sample.owner, task: sample.task, stage: sample.stage, recovery: sample.recovery }
            });
        }
        this.samples.push(sample);
        this.samples = this.samples.filter(s => s.time >= sample.time - 120000);
        return sample;
    }

    report() {
        const now = this.now();
        const recent = this.samples.filter(s => s.time >= now - 60000);
        const first = recent[0];
        const current = recent.at(-1);
        const alerts = [];
        const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;
        let travelled = 0;
        const cells = new Set();
        for (let i = 0; i < recent.length; i++) {
            const s = recent[i];
            if (s.position) cells.add(`${s.dimension}:${Math.floor(s.position.x / 3)},${Math.floor(s.position.y / 3)},${Math.floor(s.position.z / 3)}`);
            const moved = i ? distance(s.position, recent[i - 1].position) : 0;
            if (i && s.dimension === recent[i - 1].dimension && moved < 10) travelled += moved;
        }
        const duration = first && current ? current.time - first.time : 0;
        const inventoryChanged = !!first && JSON.stringify(first.inventory) !== JSON.stringify(current.inventory);
        const stageChanged = !!first && recent.some(s => s.stage !== first.stage);
        const taskChanged = !!first && recent.some(s => s.task !== first.task || s.recovery !== first.recovery);
        const combatShare = recent.length ? recent.filter(s => s.owner === 'combat').length / recent.length : 0;
        const transitions = this.events.filter(e => e.time >= now - 60000 && e.type === 'transition');
        const combatEntries = transitions.filter(e => e.to.owner === 'combat').length;
        if (duration >= 45000 && !inventoryChanged && !stageChanged && !taskChanged) {
            alerts.push({ code: 'NO_TASK_PROGRESS', message: "Tache inchangee depuis au moins 45 s, sans changement d'inventaire ni d'etape. Cela signale une stagnation possible, pas une preuve d'echec." });
            if (travelled < 2) alerts.push({ code: 'STATIONARY', message: 'Moins de 2 blocs parcourus pendant cette periode.' });
            else if (travelled > 12 && cells.size <= 8) alerts.push({ code: 'LOCAL_LOOP', message: 'Deplacements repetes dans une petite zone sans progression mesuree.' });
        }
        if (duration >= 30000 && (combatShare > 0.5 || combatEntries >= 4)) {
            alerts.push({ code: 'SURVIVAL_DOMINATES', message: 'La survie monopolise les actions ou interrompt souvent les objectifs.' });
        }
        if (current?.food <= 6) alerts.push({ code: 'LOW_FOOD', message: 'Faim critique : nourriture a 6/20 ou moins.' });
        if (current?.health <= 6) alerts.push({ code: 'LOW_HEALTH', message: 'Vie critique : sante a 6/20 ou moins.' });
        return {
            generatedAt: new Date(now).toISOString(), startedAt: new Date(this.startedAt).toISOString(),
            deaths: this.deaths, current,
            window: { seconds: Math.round(duration / 1000), samples: recent.length,
                travelled: Math.round(travelled * 10) / 10, visitedCells: cells.size,
                combatPercent: Math.round(combatShare * 100), combatEntries, inventoryChanged, stageChanged, taskChanged },
            alerts, events: this.events.slice(-50)
        };
    }

    writeReport() {
        const report = this.report();
        fs.mkdirSync(this.directory, { recursive: true });
        const safeName = String(this.bot.username || 'bot').replace(/[^a-zA-Z0-9_-]/g, '_');
        const base = path.join(this.directory, safeName);
        fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
        const c = report.current;
        const lines = [
            `Rapport du ${report.generatedAt}`, `Morts depuis le lancement : ${report.deaths}`,
            `Etape : ${c?.stage || '?'} | Tache : ${c?.task || 'aucune'} | Recuperation : ${c?.recovery ? 'oui' : 'non'}`,
            `Controle : ${c?.owner || '?'} | Vie : ${c?.health ?? '?'}/20 | Nourriture : ${c?.food ?? '?'}/20`,
            `Position : ${JSON.stringify(c?.position)} | Dimension : ${c?.dimension || '?'}`,
            `Derniere fenetre : ${report.window.seconds} s, ${report.window.travelled} blocs parcourus, ${report.window.combatPercent}% en survie, ${report.window.combatEntries} interruptions de combat.`,
            `Inventaire : ${JSON.stringify(c?.inventory || {})}`,
            `Culture : ${c?.farming || 'inactive'}`,
            `Mobs proches : ${JSON.stringify(c?.nearbyMobs || [])}`,
            `Terrain (blocs de y-2 a y+2) : ${JSON.stringify(c?.terrain || [])}`, '',
            ...report.alerts.map(a => `${a.code} : ${a.message}`)
        ];
        if (!report.alerts.length) lines.push("Aucune alerte detectee ; cela ne garantit pas que l'objectif avance.");
        fs.writeFileSync(`${base}.txt`, lines.join('\n'));
        const history = `${base}.history.jsonl`;
        // Historique borne pour une surveillance continue sans croissance illimitee.
        if (fs.existsSync(history) && fs.statSync(history).size > 5 * 1024 * 1024) {
            fs.renameSync(history, `${base}.previous.jsonl`);
        }
        fs.appendFileSync(history, JSON.stringify(report) + '\n');
        this.lastReportAt = this.now();
        if (report.alerts.length) console.log(`[Observer] ${report.alerts.map(a => a.code).join(', ')}. Rapport : ${base}.txt`);
        return report;
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        clearInterval(this.timer);
        this.bot.removeListener('death', this.onDeath);
        this.bot.removeListener('entityHurt', this.onHurt);
        this.bot.removeListener('end', this.onEnd);
        try { this.writeReport(); } catch (error) { console.error(`[Observer] ${error.message}`); }
    }
}

module.exports = BehaviorObserver;
