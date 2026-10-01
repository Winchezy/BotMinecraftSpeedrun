// WoodBrain.js - Réseau de neurones pour la stratégie de coupe d'arbres
// Décide QUEL log cibler et COMMENT se positionner selon la situation.
// Les règles jouent le rôle de "professeur" et génèrent les données automatiquement.

const fs   = require('fs');
const path = require('path');

const MODEL_PATH   = path.join(__dirname, '../../data/wood_model.json');
const DATASET_PATH = path.join(__dirname, '../../data/wood_dataset.json');

// 3 stratégies possibles
const WOOD_ACTIONS = [
    'MINE_BELOW',    // cibler le log le plus bas dans le rayon de portée (en dessous du bot)
    'MINE_BASE',     // naviguer jusqu'à la base du tronc et miner de bas en haut
    'MINE_NEAREST',  // cibler le log le plus proche (fallback)
];

// Encode l'état de la situation d'abattage en 10 flottants (0-1)
function encodeWoodState(bot, treeInfo) {
    const { logsAbove, logsBelow, logsTotal, botYInTree,
            hasLogWithinReachBelow, nearestBelowDY, nearestBelowDXZ,
            distToLowestLog } = treeInfo;

    const onGround = bot.entity?.onGround ? 1 : 0;
    const isFalling = (bot.entity?.velocity?.y ?? 0) < -0.1 ? 1 : 0;

    return [
        Math.max(0, Math.min(1, botYInTree)),                       // 0 : position dans l'arbre (0=base, 1=sommet)
        Math.min(1, logsAbove / 10),                                // 1 : logs au-dessus (normalisé)
        Math.min(1, logsBelow / 10),                                // 2 : logs en dessous (normalisé)
        hasLogWithinReachBelow ? 1 : 0,                             // 3 : log à portée sous le bot
        Math.max(0, Math.min(1, Math.abs(nearestBelowDY) / 5)),    // 4 : distance verticale au log le plus bas
        Math.max(0, Math.min(1, nearestBelowDXZ / 5)),             // 5 : distance horizontale au log le plus bas
        onGround,                                                    // 6 : bot au sol
        isFalling,                                                   // 7 : bot en chute
        Math.min(1, logsTotal / 20),                                // 8 : total logs dans l'arbre (normalisé)
        Math.max(0, Math.min(1, distToLowestLog / 10))             // 9 : distance au log le plus bas de l'arbre
    ];
}

// Règle déterministe (le "professeur") — génère les labels d'entraînement
function ruleDecide(treeInfo) {
    const { botYInTree, hasLogWithinReachBelow, nearestBelowDXZ, distToLowestLog } = treeInfo;

    if (hasLogWithinReachBelow && nearestBelowDXZ < 3) {
        return 'MINE_BELOW';
    }
    if (botYInTree > 0.3 && distToLowestLog < 10) {
        return 'MINE_BASE';
    }
    return 'MINE_NEAREST';
}

// ─── Classe principale ────────────────────────────────────────────────────────

class WoodBrain {
    constructor() {
        this.network = null;
        this.loaded  = false;
        this.dataset = this._loadDataset();
        this._loadModel();
    }

    _loadModel() {
        try {
            const { Network } = require('synaptic');
            if (fs.existsSync(MODEL_PATH)) {
                const data = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
                this.network = Network.fromJSON(data.network);
                this.loaded  = true;
                const mins = Math.round((Date.now() - new Date(data.trainedAt).getTime()) / 60000);
                console.log(`[WoodBrain] Modèle chargé (${data.examples} exemples, ${data.accuracy}% précision, entraîné il y a ${mins} min)`);
            } else {
                console.log('[WoodBrain] Pas de modèle. Les règles vont générer les données d\'entraînement.');
            }
        } catch (e) {
            console.log(`[WoodBrain] Erreur chargement modèle: ${e.message}`);
        }
    }

    _loadDataset() {
        if (!fs.existsSync(DATASET_PATH)) return [];
        try   { return JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')); }
        catch { return []; }
    }

    // Retourne l'action choisie par le réseau, ou null si pas de modèle / confiance insuffisante
    decide(bot, treeInfo) {
        this._checkModelUpdate();
        if (!this.loaded || !this.network) return null;
        try {
            const input  = encodeWoodState(bot, treeInfo);
            const output = this.network.activate(input);
            const maxVal = Math.max(...output);
            if (maxVal < 0.4) return null;
            const action = WOOD_ACTIONS[output.indexOf(maxVal)];
            console.log(`[WoodBrain] ${action} (${(maxVal * 100).toFixed(0)}%)`);
            return { action, confidence: maxVal };
        } catch { return null; }
    }

    // Enregistre uniquement si l'action a réussi (logs collectés)
    recordSuccess(bot, treeInfo, actionName) {
        try {
            const idx = WOOD_ACTIONS.indexOf(actionName);
            if (idx === -1) return;

            const input  = encodeWoodState(bot, treeInfo);
            const output = new Array(WOOD_ACTIONS.length).fill(0);
            output[idx]  = 1;

            this.dataset.push({ input, output, action: actionName, reward: 1, timestamp: Date.now() });
            const n = this.dataset.length;
            console.log(`[WoodBrain] Succès enregistré: ${actionName} (total local: ${n})`);
            if (n % 5 === 0) console.log(`[WoodBrain] >>> ${n} exemples accumulés <<<`);
            this._saveDataset(this._botDatasetPath(bot.username));
            this._checkModelUpdate();
        } catch { /* Ignore */ }
    }

    _botDatasetPath(botUsername) {
        if (!botUsername) return DATASET_PATH;
        const ext  = path.extname(DATASET_PATH);
        const base = DATASET_PATH.slice(0, -ext.length);
        return `${base}_${botUsername}${ext}`;
    }

    _saveDataset(filePath) {
        try {
            const target = filePath || DATASET_PATH;
            const tmp = target + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.dataset, null, 2));
            fs.renameSync(tmp, target);
        } catch { /* Ignore */ }
    }

    _checkModelUpdate() {
        try {
            if (!fs.existsSync(MODEL_PATH)) return;
            const mtime = fs.statSync(MODEL_PATH).mtimeMs;
            if (mtime > (this._modelMtime || 0)) {
                const { Network } = require('synaptic');
                const data = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
                this.network = Network.fromJSON(data.network);
                this.loaded  = true;
                this._modelMtime = mtime;
                console.log(`[WoodBrain] Modèle rechargé automatiquement (${data.examples} ex, ${data.accuracy}%)`);
            }
        } catch { /* Ignore */ }
    }

    saveAll() {
        this._saveDataset();
        console.log(`[WoodBrain] Sauvegardé: ${this.dataset.length} exemples`);
    }
}

// Singleton
let _instance = null;
function getInstance() {
    if (!_instance) _instance = new WoodBrain();
    return _instance;
}

module.exports = { WoodBrain, getInstance, encodeWoodState, WOOD_ACTIONS, ruleDecide };
