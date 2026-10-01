const { isHostileMob } = require('./MobThreats');
const { Vec3 } = require('vec3');

// Un creeper enferme dans une autre cavite ne justifie pas une fuite.
// Recherche conservative de connexion dans l'air : les sols ne limitent pas
// la recherche, pour compter aussi les chutes et les passages au-dessus.
function hasMobAccess(bot, point, entity, openings = []) {
    if (['warden', 'ghast', 'blaze', 'phantom', 'vex'].includes(entity.name) || !bot.blockAt) return true;
    const opened = new Set(openings.map(p => p.floored().toString()));
    const start = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
    const target = entity.position.floored();
    const queue = [start];
    const seen = new Set([start.toString()]);
    const radius = Math.ceil(start.distanceTo(target)) + 3;
    const passable = p => {
        if (opened.has(p.toString())) return true;
        const block = bot.blockAt(p);
        // Terrain inconnu : impossible de prouver une separation.
        return !block || block.boundingBox !== 'block';
    };
    for (let i = 0; i < queue.length; i++) {
        if (i >= 2048) return true;
        const p = queue[i];
        if (p.distanceTo(target) < 1.5) return true;
        for (const [x, y, z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
            const next = p.offset(x, y, z);
            const key = next.toString();
            if (seen.has(key) || next.distanceTo(start) > radius) continue;
            if (!passable(next) || !passable(next.offset(0, 1, 0))) continue;
            seen.add(key);
            queue.push(next);
        }
    }
    return false;
}

function routeThreats(bot) {
    return Object.values(bot.entities || {}).filter(entity =>
        entity.position && (isHostileMob(entity) || entity.name === 'spider'));
}

function threatRadius(entity, groupSize) {
    if (entity.name === 'skeleton' || entity.name === 'stray') return 15;
    if (entity.name === 'creeper') return 16;
    return groupSize >= 2 ? 12 : 9;
}

function awarenessRadius(bot, entity, fallback) {
    const state = bot.mobAwareness?.observations.get(entity.id)?.state;
    if (!state || state === 'hostile') return fallback;
    // Garder une marge d'approche, sans traiter un mob lointain comme une attaque.
    return Math.min(fallback, entity.name === 'creeper' ? 8 : /skeleton|stray|pillager/.test(entity.name) ? 10 : 6);
}

function threatNearPath(bot, path) {
    const threats = routeThreats(bot);
    if (!path?.length || !threats.length) return null;
    const steps = path;
    for (const step of steps) {
        for (const threat of threats) {
            if (Math.abs(step.y - threat.position.y) > 4) continue;
            const distance = Math.hypot(step.x - threat.position.x, step.z - threat.position.z);
            if (distance < awarenessRadius(bot, threat, threatRadius(threat, threats.length)) && hasMobAccess(bot, step, threat)) return threat;
        }
    }
    return null;
}

// Distance (3D) a laquelle Survival declenche une retraite (cf. decideResponse).
// Une cible plus proche que ca d'un mob est inatteignable : le bot fuirait avant d'arriver.
function retreatRadius(entity, groupSize) {
    if (entity.name === 'creeper' || groupSize >= 2) return 16;
    if (entity.name === 'skeleton' || entity.name === 'stray') return 14;
    if (['warden', 'ravager', 'piglin_brute', 'ghast', 'blaze'].includes(entity.name)) return 12;
    return 8;
}

// Mob dont la zone de retraite couvre `pos` (+ marge = distance de travail du bot).
function threatNearPoint(bot, pos, margin = 0, openings = []) {
    // Groupe = mobs proches du point (comme Survival compte ceux proches du bot),
    // pas tous les mobs charges dans le monde.
    const threats = routeThreats(bot).filter(entity => entity.position.distanceTo(pos) < 16 + margin);
    return threats.find(entity =>
        entity.position.distanceTo(pos) < awarenessRadius(bot, entity, retreatRadius(entity, threats.length)) + margin && hasMobAccess(bot, pos, entity, openings)) || null;
}

module.exports = { routeThreats, threatNearPath, threatNearPoint, hasMobAccess };
