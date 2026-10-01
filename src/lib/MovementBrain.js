// MovementBrain.js - Réseaux de neurones pour guider DigDown et MoveToSurface
// Deux réseaux séparés : un pour descendre, un pour remonter en surface.
// Les règles existantes génèrent automatiquement les données d'entraînement.

const fs   = require('fs');
const path = require('path');

const DIGDOWN_MODEL_PATH   = path.join(__dirname, '../../data/digdown_model.json');
const SURFACE_MODEL_PATH   = path.join(__dirname, '../../data/surface_model.json');
const DIGDOWN_DATASET_PATH = path.join(__dirname, '../../data/digdown_dataset.json');
const SURFACE_DATASET_PATH = path.join(__dirname, '../../data/surface_dataset.json');

const DIGDOWN_ACTIONS = ['DIG_HEAD', 'DIG_BODY', 'DIG_FLOOR', 'DIG_UNDER', 'MOVE_FORWARD', 'TURN_AND_STOP'];
const SURFACE_ACTIONS = ['PILLAR_UP', 'DIG_CEILING', 'DIG_FORWARD', 'STAIRCASE_UP', 'STOP'];

// ─── Encodage de l'état pour DigDown (14 features) ───────────────────────────

function encodeDigDownState(bot, targetY, forward, stuckTicks = 0) {
    const pos    = bot.entity.position;
    const botPos = pos.floored();
    const dx     = forward.x;
    const dz     = forward.z;

    const targetHead   = botPos.offset(dx, 1,  dz);
    const targetBody   = botPos.offset(dx, 0,  dz);
    const targetFloor  = botPos.offset(dx, -1, dz);
    const targetFloor2 = botPos.offset(dx, -2, dz);

    const isSolid  = v => { const b = bot.blockAt(v); return !!(b && b.boundingBox === 'block'); };
    const isLiquid = v => { const b = bot.blockAt(v); return !!(b && (b.name.includes('lava') || b.name.includes('water'))); };

    const hasBridgeBlocks = bot.inventory.items().some(i =>
        i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
        i.name === 'netherrack'  || i.name.includes('planks') || i.name.includes('log')
    );
    const hasPickaxe = bot.inventory.items().some(i => i.name.includes('pickaxe'));

    // Diamants à portée ?
    const mcData = require('minecraft-data')(bot.version);
    const diamondIds = [
        mcData.blocksByName.diamond_ore?.id,
        mcData.blocksByName.deepslate_diamond_ore?.id
    ].filter(Boolean);
    const diamondNearby = !!bot.findBlock({ matching: diamondIds, maxDistance: 5 });

    // Liquide dans un rayon de 3 ?
    const liquidNearby = !!bot.findBlock({
        matching: b => b.name.includes('water') || b.name.includes('lava'),
        maxDistance: 3
    });

    // Vide sous prochain bloc (air et pas solide et pas liquide)
    const blkF2      = bot.blockAt(targetFloor2);
    const isVoidF2   = !blkF2 || (blkF2.name === 'air' && blkF2.boundingBox !== 'block');

    const yNorm      = Math.max(0, Math.min(1, (pos.y + 64) / 384));
    const targetYNorm = Math.max(0, Math.min(1, (targetY + 64) / 384));
    const startY     = 64;
    const yRange     = Math.abs(targetY - startY) || 1;
    const yProgress  = Math.max(0, Math.min(1, (startY - pos.y) / yRange));

    return [
        yNorm,                                      // 0: Y actuel normalisé
        targetYNorm,                               // 1: Y cible normalisé
        yProgress,                                 // 2: progression vers cible (0→1)
        isSolid(targetHead)   ? 1 : 0,            // 3: bloc devant (tête)
        isSolid(targetBody)   ? 1 : 0,            // 4: bloc devant (corps)
        isSolid(targetFloor)  ? 1 : 0,            // 5: bloc devant (sol)
        isSolid(targetFloor2) ? 1 : 0,            // 6: sol sous le prochain bloc
        isLiquid(targetFloor2) ? 1 : 0,           // 7: liquide sous le prochain bloc
        isVoidF2 && !isSolid(targetFloor2) ? 1 : 0, // 8: vide sous le prochain bloc
        hasBridgeBlocks ? 1 : 0,                  // 9: a des blocs pour bridger
        hasPickaxe ? 1 : 0,                       // 10: a une pioche
        diamondNearby ? 1 : 0,                    // 11: diamants proches
        Math.min(stuckTicks, 40) / 40,           // 12: ticks bloqué (normalisé)
        liquidNearby ? 1 : 0                      // 13: liquide à proximité
    ];
}

// ─── Encodage de l'état pour MoveToSurface (12 features) ─────────────────────

function encodeSurfaceState(bot, stuckCount = 0, startY = null) {
    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;

    // Snap vers la direction cardinale la plus proche
    const cardinals = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    let bestYaw  = cardinals[0];
    let minDiff  = Infinity;
    for (const y of cardinals) {
        let diff = Math.abs(y - yaw);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < minDiff) { minDiff = diff; bestYaw = y; }
    }

    const fwdX = Math.round(-Math.sin(bestYaw));
    const fwdZ = Math.round(-Math.cos(bestYaw));

    const isSolid = (ox, oy, oz) => {
        const b = bot.blockAt({ x: Math.floor(pos.x + ox), y: Math.floor(pos.y + oy), z: Math.floor(pos.z + oz) });
        return !!(b && b.boundingBox === 'block');
    };

    const blockAbove = bot.blockAt({ x: Math.floor(pos.x), y: Math.floor(pos.y + 2), z: Math.floor(pos.z) });
    const skyLight   = blockAbove ? (blockAbove.skyLight ?? 0) : 0;

    const targetY        = 64;
    const effectiveStart = startY ?? -54;
    const yRange         = Math.abs(targetY - effectiveStart) || 1;
    const yProgress      = Math.max(0, Math.min(1, (pos.y - effectiveStart) / yRange));
    const yNorm          = Math.max(0, Math.min(1, (pos.y + 64) / 384));

    const inv = bot.inventory.items();
    const hasPlaceableBlocks = inv.some(i =>
        i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
        i.name === 'netherrack'  || i.name.includes('planks') || i.name.includes('log')
    );
    const hasPickaxe = inv.some(i => i.name.includes('pickaxe'));

    return [
        yNorm,                             // 0: Y normalisé
        yProgress,                         // 1: progression vers surface
        hasPlaceableBlocks ? 1 : 0,       // 2: a des blocs
        hasPickaxe ? 1 : 0,               // 3: a une pioche
        isSolid(0, 2, 0) ? 1 : 0,        // 4: bloc au-dessus de la tête
        isSolid(0, 3, 0) ? 1 : 0,        // 5: bloc encore plus haut
        isSolid(fwdX, 1, fwdZ) ? 1 : 0,  // 6: bloc en face (niveau tête)
        isSolid(fwdX, 2, fwdZ) ? 1 : 0,  // 7: bloc en face (au-dessus)
        isSolid(fwdX, 0, fwdZ) ? 1 : 0,  // 8: sol devant
        skyLight / 15,                     // 9: lumière du ciel
        Math.min(stuckCount, 20) / 20,   // 10: compteur bloqué
        (bot.entity?.onGround) ? 1 : 0   // 11: au sol
    ];
}

// ─── Classe principale ────────────────────────────────────────────────────────

class MovementBrain {
    constructor() {
        this.digNetwork     = null;
        this.surfaceNetwork = null;
        this.digLoaded      = false;
        this.surfaceLoaded  = false;
        this.digDataset     = this._loadDataset(DIGDOWN_DATASET_PATH);
        this.surfaceDataset = this._loadDataset(SURFACE_DATASET_PATH);
        this._loadModels();
    }

    _loadModels() {
        try {
            const { Network } = require('synaptic');
            if (fs.existsSync(DIGDOWN_MODEL_PATH)) {
                const data = JSON.parse(fs.readFileSync(DIGDOWN_MODEL_PATH, 'utf-8'));
                this.digNetwork  = Network.fromJSON(data.network);
                this.digLoaded   = true;
                console.log(`[MovementBrain] DigDown chargé (${data.examples} ex, ${data.accuracy}%)`);
            }
            if (fs.existsSync(SURFACE_MODEL_PATH)) {
                const data = JSON.parse(fs.readFileSync(SURFACE_MODEL_PATH, 'utf-8'));
                this.surfaceNetwork  = Network.fromJSON(data.network);
                this.surfaceLoaded   = true;
                console.log(`[MovementBrain] Surface chargé (${data.examples} ex, ${data.accuracy}%)`);
            }
            if (!this.digLoaded && !this.surfaceLoaded) {
                console.log('[MovementBrain] Pas de modèles. Les règles vont générer les données d\'entraînement.');
            }
        } catch (e) {
            console.log(`[MovementBrain] Erreur chargement modèles: ${e.message}`);
        }
    }

    _loadDataset(filePath) {
        if (!fs.existsSync(filePath)) return [];
        try   { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
        catch { return []; }
    }

    // ── Décision DigDown ──────────────────────────────────────────────────────

    decideDigAction(bot, targetY, forward, stuckTicks = 0) {
        this._checkModelUpdates();
        if (!this.digLoaded || !this.digNetwork) return null;
        try {
            const input  = encodeDigDownState(bot, targetY, forward, stuckTicks);
            const output = this.digNetwork.activate(input);
            const maxVal = Math.max(...output);
            if (maxVal < 0.4) return null;
            const action = DIGDOWN_ACTIONS[output.indexOf(maxVal)];
            console.log(`[MovementBrain] DigDown: ${action} (${(maxVal * 100).toFixed(0)}%)`);
            return { action, confidence: maxVal };
        } catch { return null; }
    }

    // ── Décision MoveToSurface ────────────────────────────────────────────────

    decideSurfaceAction(bot, stuckCount = 0, startY = null) {
        if (!this.surfaceLoaded || !this.surfaceNetwork) return null;
        try {
            const input  = encodeSurfaceState(bot, stuckCount, startY);
            const output = this.surfaceNetwork.activate(input);
            const maxVal = Math.max(...output);
            if (maxVal < 0.4) return null;
            const action = SURFACE_ACTIONS[output.indexOf(maxVal)];
            console.log(`[MovementBrain] Surface: ${action} (${(maxVal * 100).toFixed(0)}%)`);
            return { action, confidence: maxVal };
        } catch { return null; }
    }

    // ── Enregistrement pour l'entraînement ───────────────────────────────────

    // Enregistre si le bot a progressé vers le bas (yAfter < yBefore)
    recordDigSuccess(bot, actionName, targetY, forward, stuckTicks = 0, yBefore = null) {
        try {
            const yNow = bot.entity.position.y;
            if (yBefore !== null && yNow >= yBefore - 0.3) return; // pas de descente → ignorer
            const idx = DIGDOWN_ACTIONS.indexOf(actionName);
            if (idx === -1) return;
            const input  = encodeDigDownState(bot, targetY, forward, stuckTicks);
            const output = new Array(DIGDOWN_ACTIONS.length).fill(0);
            output[idx]  = 1;
            const example = { input, output, action: actionName, reward: 1, timestamp: Date.now() };
            this.digDataset.push(example);
            const botFile = this._botDatasetPath(DIGDOWN_DATASET_PATH, bot.username);
            this._saveDataset(botFile, this.digDataset);
            console.log(`[MovementBrain] DigDown succès: ${actionName} (total local: ${this.digDataset.length})`);
            this._checkModelUpdates();
        } catch { /* Ignore */ }
    }

    // Enregistre une action de remontée (toujours, car les règles sont correctes même sans gain de Y immédiat)
    recordSurfaceSuccess(bot, actionName, stuckCount = 0, startY = null, yBefore = null) {
        try {
            const yNow = bot.entity.position.y;
            if (yBefore !== null && yNow < yBefore - 2) return; // chute significative → ignorer
            const idx = SURFACE_ACTIONS.indexOf(actionName);
            if (idx === -1) return;
            const input  = encodeSurfaceState(bot, stuckCount, startY);
            const output = new Array(SURFACE_ACTIONS.length).fill(0);
            output[idx]  = 1;
            const example = { input, output, action: actionName, reward: 1, timestamp: Date.now() };
            this.surfaceDataset.push(example);
            const botFile = this._botDatasetPath(SURFACE_DATASET_PATH, bot.username);
            this._saveDataset(botFile, this.surfaceDataset);
            console.log(`[MovementBrain] Surface succès: ${actionName} (total local: ${this.surfaceDataset.length})`);
            this._checkModelUpdates();
        } catch { /* Ignore */ }
    }

    // Alias conservés pour compatibilité
    recordDigAction(bot, actionName, targetY, forward, stuckTicks = 0) {
        this.recordDigSuccess(bot, actionName, targetY, forward, stuckTicks, null);
    }

    recordSurfaceAction(bot, actionName, stuckCount = 0, startY = null) {
        this.recordSurfaceSuccess(bot, actionName, stuckCount, startY, null);
    }

    // Sauvegarde dans un fichier propre à ce bot pour éviter les collisions multi-bot
    _botDatasetPath(basePath, botUsername) {
        if (!botUsername) return basePath;
        const ext  = path.extname(basePath);
        const base = basePath.slice(0, -ext.length);
        return `${base}_${botUsername}${ext}`;
    }

    _saveDataset(filePath, dataset) {
        try {
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(dataset, null, 2));
            fs.renameSync(tmp, filePath);
        } catch { /* Ignore */ }
    }

    saveAll() {
        this._saveDataset(DIGDOWN_DATASET_PATH, this.digDataset);
        this._saveDataset(SURFACE_DATASET_PATH, this.surfaceDataset);
        console.log(`[MovementBrain] Sauvegardés: ${this.digDataset.length} dig, ${this.surfaceDataset.length} surface`);
    }

    // Rechargement automatique du modèle si le fichier a changé (entraînement par auto_trainer)
    _checkModelUpdates() {
        try {
            if (fs.existsSync(DIGDOWN_MODEL_PATH)) {
                const mtime = fs.statSync(DIGDOWN_MODEL_PATH).mtimeMs;
                if (mtime > (this._digModelMtime || 0)) {
                    const { Network } = require('synaptic');
                    const data = JSON.parse(fs.readFileSync(DIGDOWN_MODEL_PATH, 'utf-8'));
                    this.digNetwork = Network.fromJSON(data.network);
                    this.digLoaded  = true;
                    this._digModelMtime = mtime;
                    console.log(`[MovementBrain] DigDown rechargé automatiquement (${data.examples} ex, ${data.accuracy}%)`);
                }
            }
            if (fs.existsSync(SURFACE_MODEL_PATH)) {
                const mtime = fs.statSync(SURFACE_MODEL_PATH).mtimeMs;
                if (mtime > (this._surfModelMtime || 0)) {
                    const { Network } = require('synaptic');
                    const data = JSON.parse(fs.readFileSync(SURFACE_MODEL_PATH, 'utf-8'));
                    this.surfaceNetwork = Network.fromJSON(data.network);
                    this.surfaceLoaded  = true;
                    this._surfModelMtime = mtime;
                    console.log(`[MovementBrain] Surface rechargé automatiquement (${data.examples} ex, ${data.accuracy}%)`);
                }
            }
        } catch { /* Ignore */ }
    }
}

// Singleton partagé entre DigDown et MoveToSurface
let _instance = null;
function getInstance() {
    if (!_instance) _instance = new MovementBrain();
    return _instance;
}

module.exports = {
    MovementBrain,
    getInstance,
    encodeDigDownState,
    encodeSurfaceState,
    DIGDOWN_ACTIONS,
    SURFACE_ACTIONS
};
