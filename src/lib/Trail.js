const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');

// Fil d'Ariane : les positions parcourues SOUS TERRE depuis le dernier point de
// surface. Ces cases sont deja creusees/praticables -> le chemin de retour le plus
// sur et le moins couteux (pas besoin de creuser un nouveau puits ou de pilier).
const STEP = 2;          // distance mini entre deux points enregistres
const LOOP_RADIUS = 1.5; // revenir pres d'un ancien point = on coupe la boucle
const MAX_POINTS = 2000;
const FALL_HEIGHT = 4;   // descente plus rapide qu'un escalier entre deux releves (500 ms)

class Trail {
    constructor() {
        this.points = [];
    }

    clear() {
        this.points = [];
    }

    restore(points) {
        this.points = Array.isArray(points) ? points.slice(-MAX_POINTS)
            .filter(p => p && [p.x, p.y, p.z].every(Number.isFinite))
            .map(p => new Vec3(p.x, p.y, p.z)) : [];
    }

    // pos : position des pieds. atSurface : ciel visible au-dessus du bot.
    record(pos, atSurface) {
        const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
        if (atSurface) {
            // Nouveau point de depart : seule la derniere entree sous terre compte.
            this.points = [p];
            return;
        }
        if (this.points.length === 0) return; // spawn sous terre : pas d'ancre de surface
        const last = this.points[this.points.length - 1];
        if (last.y - p.y > FALL_HEIGHT) {
            // Chute (grotte, trou) : impossible de remonter a pied par la trace.
            this.clear();
            return;
        }
        if (last.distanceTo(p) < STEP) return;

        // Le bot repasse pres d'un point deja enregistre (demi-tour, cul-de-sac) :
        // on retire le detour pour que le retour prenne le trajet le plus direct.
        for (let i = 0; i < this.points.length - 1; i++) {
            if (this.points[i].distanceTo(p) <= LOOP_RADIUS) {
                this.points.length = i + 1;
                return;
            }
        }
        this.points.push(p);
        if (this.points.length > MAX_POINTS) this.points.shift();
    }

    // Index du point de trace le plus proche de `pos` (ou -1 si aucun a portee).
    nearestIndex(pos, maxDistance = 6) {
        let best = -1;
        let bestDist = maxDistance;
        for (let i = 0; i < this.points.length; i++) {
            const d = this.points[i].distanceTo(pos);
            if (d <= bestDist) { best = i; bestDist = d; }
        }
        return best;
    }

    // Prochain point a viser en remontant la trace (quelques crans vers la surface).
    nextWaypoint(pos, stride = 6) {
        const i = this.nearestIndex(pos);
        if (i < 0) return null;
        return { index: Math.max(0, i - stride), point: this.points[Math.max(0, i - stride)] };
    }
}

function isAtSurface(bot) {
    const pos = bot.entity.position;
    const head = bot.blockAt(pos.offset(0, 2, 0));
    return pos.y > 62 && !!head && head.skyLight >= 14;
}

// Enregistre en continu la trace du bot (utilisee par MoveToSurface).
function attachTrail(bot) {
    const trail = new Trail();
    bot.trail = trail;
    let lastDimension = bot.game?.dimension;
    const directory = path.join(__dirname, '../../.bot-state');
    const filename = path.join(directory, `trail-${String(bot.username || 'bot').replace(/[^a-z0-9_-]/gi, '_')}.json`);
    const server = `${bot._client?.socket?.remoteAddress}:${bot._client?.socket?.remotePort}`;
    try {
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (saved.dimension === lastDimension && saved.server === server) trail.restore(saved.points);
    } catch (_) { }
    const save = () => {
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(filename + '.tmp', JSON.stringify({ dimension: lastDimension, server, points: trail.points }));
            fs.renameSync(filename + '.tmp', filename);
        } catch (error) { console.log(`[Trail] Sauvegarde impossible: ${error.message}`); }
    };
    let lastSave = 0;
    const timer = setInterval(() => {
        if (!bot.entity) return;
        if (bot.game?.dimension !== lastDimension) {
            lastDimension = bot.game?.dimension;
            trail.clear();
        }
        trail.record(bot.entity.position, isAtSurface(bot));
        if (Date.now() - lastSave > 5000) { save(); lastSave = Date.now(); }
    }, 500);
    bot.on('death', () => { trail.clear(); save(); });
    bot.once('end', () => { clearInterval(timer); save(); });
    return trail;
}

module.exports = { Trail, attachTrail, isAtSurface };
