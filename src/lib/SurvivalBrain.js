// SurvivalBrain.js - Réseau de neurones pour les décisions de survie
// Remplace graduellement la logique basée sur des règles dans Survival.js
// Les règles jouent le rôle de "professeur" et génèrent les données d'entraînement automatiquement.

const fs = require('fs');
const path = require('path');

const MODEL_PATH    = path.join(__dirname, '../../data/survival_model.json');
const DATASET_PATH  = path.join(__dirname, '../../data/survival_dataset.json');

// 7 actions possibles
const SURVIVAL_ACTIONS = ['DO_NOTHING', 'EAT_FOOD', 'FIGHT', 'FLEE', 'BLOCK_WATER', 'JUMP_SWIM', 'FIND_LAND'];

// Encode l'état de survie en vecteur de 18 flottants (0-1)
function encodeSurvivalState(bot, context = {}) {
    const pos = bot.entity ? bot.entity.position : { x: 0, y: 64, z: 0, distanceTo: () => 16 };
    const flooredPos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const headPos    = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1.6), z: Math.floor(pos.z) };

    const feetBlock  = bot.blockAt ? bot.blockAt(flooredPos) : null;
    const headBlock  = bot.blockAt ? bot.blockAt(headPos)    : null;
    const inWater    = !!(feetBlock?.name?.includes('water') || headBlock?.name?.includes('water'));

    const hostileNames = [
        'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'slime',
        'phantom', 'drowned', 'husk', 'stray', 'blaze', 'ghast', 'magma_cube',
        'hoglin', 'piglin_brute', 'warden', 'wither_skeleton'
    ];

    let nearbyHostiles = [];
    let closestDist    = 16;
    let nearCreeper    = false;
    let nearSkeleton   = false;

    if (bot.entities) {
        for (const e of Object.values(bot.entities)) {
            if (!e?.name || !e.position) continue;
            const isHostile = hostileNames.some(h => e.name.toLowerCase().includes(h));
            if (!isHostile) continue;
            const dist = pos.distanceTo ? pos.distanceTo(e.position) : 16;
            if (dist < 16) {
                nearbyHostiles.push(dist);
                if (dist < closestDist) closestDist = dist;
                if (e.name.includes('creeper'))  nearCreeper  = true;
                if (e.name.includes('skeleton')) nearSkeleton = true;
            }
        }
    }

    const inv = bot.inventory ? bot.inventory.items() : [];
    const hasSword          = inv.some(i => i.name.includes('sword'));
    const hasAxe            = inv.some(i => i.name.includes('axe') && !i.name.includes('pickaxe'));
    const hasFood           = inv.some(i =>
        i.name.includes('flesh') || i.name.includes('beef')  || i.name.includes('pork')    ||
        i.name.includes('bread') || i.name.includes('apple') || i.name.includes('carrot')  ||
        i.name.includes('potato') || i.name.includes('chicken') || i.name.includes('mutton')
    );
    const hasPlaceableBlocks = inv.some(i =>
        i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
        i.name.includes('planks') || i.name.includes('log')
    );

    const vel    = bot.entity?.velocity;
    const velMag = vel ? Math.sqrt(vel.x ** 2 + vel.z ** 2) : 0;

    const groupThreat = nearbyHostiles.filter(d => d < 10).length >= 2;
    const health      = bot.health ?? 20;

    return [
        health / 20,                                            // 0: santé normalisée
        (bot.food ?? 20) / 20,                                 // 1: nourriture normalisée
        inWater ? 1 : 0,                                       // 2: dans l'eau
        pos.y < 60 ? 1 : 0,                                   // 3: sous terre
        Math.min(nearbyHostiles.length, 5) / 5,               // 4: nombre de mobs hostiles
        nearbyHostiles.length > 0 ? closestDist / 16 : 1,    // 5: distance au plus proche (1=loin)
        hasSword ? 1 : 0,                                      // 6: a une épée
        hasAxe ? 1 : 0,                                        // 7: a une hache
        hasFood ? 1 : 0,                                       // 8: a de la nourriture
        hasPlaceableBlocks ? 1 : 0,                           // 9: a des blocs à poser
        (bot.entity?.onGround) ? 1 : 0,                       // 10: au sol
        context.recentDamage ? 1 : 0,                         // 11: a pris des dégâts récemment
        nearCreeper ? 1 : 0,                                   // 12: creeper proche
        nearSkeleton ? 1 : 0,                                  // 13: squelette proche
        Math.min(velMag, 0.4) / 0.4,                          // 14: vitesse dans l'eau
        health < 7 ? 1 : 0,                                   // 15: santé critique
        groupThreat ? 1 : 0,                                   // 16: groupe de mobs
        Math.max(0, Math.min(1, (pos.y + 64) / 384))          // 17: Y normalisé
    ];
}

class SurvivalBrain {
    constructor() {
        this.network  = null;
        this.isLoaded = false;
        this.dataset  = this._loadDataset();
        this._loadModel();
    }

    _loadModel() {
        if (!fs.existsSync(MODEL_PATH)) {
            console.log('[SurvivalBrain] Pas de modèle. Les règles vont générer les données d\'entraînement.');
            return;
        }
        try {
            const { Network } = require('synaptic');
            const data = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
            this.network  = Network.fromJSON(data.network);
            this.isLoaded = true;
            const age = Math.round((Date.now() - new Date(data.trainedAt).getTime()) / 60000);
            console.log(`[SurvivalBrain] Modèle chargé (${data.examples} ex, ${data.accuracy}% précision, ${age} min)`);
        } catch (e) {
            console.log(`[SurvivalBrain] Erreur chargement: ${e.message}`);
        }
    }

    _loadDataset() {
        if (!fs.existsSync(DATASET_PATH)) return [];
        try   { return JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')); }
        catch { return []; }
    }

    // Rechargement automatique si le modèle a été mis à jour par auto_trainer
    _checkModelUpdate() {
        try {
            if (!fs.existsSync(MODEL_PATH)) return;
            const mtime = fs.statSync(MODEL_PATH).mtimeMs;
            if (mtime > (this._modelMtime || 0)) {
                const { Network } = require('synaptic');
                const data = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
                this.network  = Network.fromJSON(data.network);
                this.isLoaded = true;
                this._modelMtime = mtime;
                console.log(`[SurvivalBrain] Modèle rechargé automatiquement (${data.examples} ex, ${data.accuracy}%)`);
            }
        } catch { /* Ignore */ }
    }

    // Décide une action de survie. Retourne { action, confidence } ou null.
    decide(bot, context = {}) {
        this._checkModelUpdate();
        if (!this.isLoaded || !this.network) return null;
        try {
            const input   = encodeSurvivalState(bot, context);
            const output  = this.network.activate(input);
            const maxVal  = Math.max(...output);
            if (maxVal < 0.35) return null;
            const action = SURVIVAL_ACTIONS[output.indexOf(maxVal)];
            console.log(`[SurvivalBrain] ${action} (confiance: ${(maxVal * 100).toFixed(0)}%)`);
            return { action, confidence: maxVal };
        } catch { return null; }
    }

    // Enregistre uniquement si l'action a produit un résultat positif (reward-based).
    recordSuccess(bot, actionName, context = {}) {
        try {
            const idx = SURVIVAL_ACTIONS.indexOf(actionName);
            if (idx === -1) return;
            const input  = encodeSurvivalState(bot, context);
            const output = new Array(SURVIVAL_ACTIONS.length).fill(0);
            output[idx]  = 1;
            this.dataset.push({ input, output, action: actionName, reward: 1, timestamp: Date.now() });
            const n = this.dataset.length;
            console.log(`[SurvivalBrain] Succès enregistré: ${actionName} (total: ${n})`);
            this._saveDataset(bot.username);
        } catch { /* Ignore */ }
    }

    // Alias conservé pour compatibilité
    recordDecision(bot, actionName, context = {}) {
        this.recordSuccess(bot, actionName, context);
    }

    _botDatasetPath(username) {
        if (!username) return DATASET_PATH;
        const ext  = path.extname(DATASET_PATH);
        const base = DATASET_PATH.slice(0, -ext.length);
        return `${base}_${username}${ext}`;
    }

    _saveDataset(username) {
        try {
            const filePath = this._botDatasetPath(username);
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.dataset, null, 2));
            fs.renameSync(tmp, filePath);
        } catch { /* Ignore */ }
    }

    saveDataset() { this._saveDataset(); }

    getDatasetSize() { return this.dataset.length; }
}

// Singleton
let _instance = null;
function getInstance() {
    if (!_instance) _instance = new SurvivalBrain();
    return _instance;
}

module.exports = { SurvivalBrain, getInstance, encodeSurvivalState, SURVIVAL_ACTIONS };
