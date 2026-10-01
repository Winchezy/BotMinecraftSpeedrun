const { Vec3 } = require('vec3');

function disableDiagonalMoves(movements) {
    const getNeighbors = movements.getNeighbors.bind(movements);
    movements.getNeighbors = node => getNeighbors(node).filter(move =>
        move.x === node.x || move.z === node.z
    );
    return movements;
}

const CLEARABLE_BLOCKS = new Set([
    'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate',
    'dirt', 'grass_block', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack'
]);

function findBlockingStep(bot, pos, next) {
    if (!next || !bot.pathfinder.movements.canDig || bot.isInCombat?.() || bot.health < 7) return null;
    if (Math.hypot(next.x - pos.x, next.z - pos.z) > 1.6) return null;
    if (next.y < pos.y - 0.2 || next.y > pos.y + 1.5) return null;
    const y = Math.floor(pos.y);
    const positions = [
        new Vec3(Math.floor(next.x), y, Math.floor(next.z)),
        new Vec3(Math.floor(next.x), y, Math.floor(pos.z)),
        new Vec3(Math.floor(pos.x), y, Math.floor(next.z))
    ];
    for (const position of positions) {
        if (position.x === Math.floor(pos.x) && position.z === Math.floor(pos.z)) continue;
        const block = bot.blockAt(position);
        const floor = bot.blockAt(position.offset(0, -1, 0));
        const head = bot.blockAt(position.offset(0, 1, 0));
        if (!block || !floor || !head || !CLEARABLE_BLOCKS.has(block.name) ||
            floor.boundingBox !== 'block' || head.boundingBox !== 'empty' ||
            !bot.canDigBlock(block)) continue;
        const adjacent = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
        if (adjacent.some(([dx, dy, dz]) => {
            const neighbor = bot.blockAt(position.offset(dx, dy, dz));
            return !neighbor || /water|lava/.test(neighbor.name);
        })) continue;
        return block;
    }
    return null;
}

function findCardinalWaypoint(bot, pos, next) {
    if (!next) return null;
    const current = pos.floored();
    const target = new Vec3(Math.floor(next.x), Math.floor(next.y), Math.floor(next.z));
    if (current.x === target.x || current.z === target.z) return null;
    const candidates = [
        new Vec3(current.x, target.y, target.z),
        new Vec3(target.x, target.y, current.z)
    ];
    for (const waypoint of candidates) {
        const floor = bot.blockAt(waypoint.offset(0, -1, 0));
        const feet = bot.blockAt(waypoint);
        const head = bot.blockAt(waypoint.offset(0, 1, 0));
        if (floor?.boundingBox === 'block' && feet?.boundingBox === 'empty' &&
            head?.boundingBox === 'empty' &&
            !/water|lava|fire|magma/.test(floor.name + feet.name + head.name)) {
            return waypoint;
        }
    }
    return null;
}

// mineflayer-pathfinder : stop() ne fait que lever un drapeau, consomme a l'arrivee
// sur le prochain noeud du chemin. Si le bot est au repos, ou si un nouveau trajet est
// lance avant ce noeud, le drapeau tue le PROCHAIN goto(), quel que soit l'appelant
// ("Path was stopped" juste apres une retraite de Survival, etc.).
// On force donc sa consommation (resetPath via setMovements, qui emet 'path_stop'
// comme un arret normal) : tout de suite au repos, sinon avant le prochain trajet.
function makeIdleStopImmediate(bot) {
    const pf = bot.pathfinder;
    const rawStop = pf.stop;
    const rawSetGoal = pf.setGoal;
    const rawGoto = pf.goto;
    let pending = false;
    const consume = () => {
        if (!pending) return;
        pending = false;
        if (pf.movements) pf.setMovements(pf.movements);
    };
    bot.on?.('path_stop', () => { pending = false; });

    pf.stop = () => {
        rawStop();
        pending = true;
        if (!pf.isMoving() && !pf.isMining() && !pf.isBuilding()) consume();
    };
    pf.setGoal = (...args) => { consume(); return rawSetGoal(...args); };
    pf.goto = (...args) => { consume(); return rawGoto(...args); };
}

// Borne une action (goto, dig, placeBlock...) dans le temps ; au timeout on arrete
// le pathfinder pour ne pas laisser le bot marcher vers un ancien objectif.
function withTimeout(bot, promise, ms, label = 'timeout') {
    promise.catch(() => { });
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                try { bot.pathfinder.stop(); } catch (_) { }
                reject(new Error(label));
            }, ms);
        })
    ]).finally(() => clearTimeout(timer));
}

async function planCompletePath(bot, goal, timeout = 1200, movements = bot.pathfinder.movements, options = {}) {
    const generator = bot.pathfinder.getPathFromTo(
        movements, bot.entity.position, goal, { timeout, tickTimeout: 15, searchRadius: 32 }
    );
    let result;
    for (const step of generator) {
        result = step.result;
        if (result.generatedNodes > 25000) return { status: 'searchLimit', path: [] };
        if (result.status !== 'partial') break;
        await new Promise(resolve => setImmediate(resolve));
        if (options.shouldInterrupt?.() || (!options.allowCombat && bot.isInCombat?.())) return { status: 'interrupted', path: [] };
    }
    // Ne pas retenir result.context (tout l'arbre A*) pendant un goto asynchrone.
    return result ? { status: result.status, path: result.path, cost: result.cost } : { status: 'noPath', path: [] };
}

function existingPassageMovements(bot) {
    const { Movements } = require('mineflayer-pathfinder');
    const movements = Object.assign(new Movements(bot), bot.pathfinder.movements);
    // La fonction de filtrage des diagonales est liee a son instance d'origine.
    delete movements.getNeighbors;
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.countScaffoldingItems = () => 0;
    return disableDiagonalMoves(movements);
}

module.exports = { disableDiagonalMoves, findBlockingStep, findCardinalWaypoint, makeIdleStopImmediate, withTimeout, planCompletePath, existingPassageMovements };
