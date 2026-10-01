// LocalBrain.js - Remplace Brain.js avec un modèle entraîné localement (aucune API cloud)
// Utilise le modèle généré par scripts/train.js

const fs = require('fs');
const path = require('path');
const { Network } = require('synaptic');
const { encodeState, decodeAction, ACTIONS } = require('./Recorder');

const MODEL_PATH = path.join(__dirname, '../data/model.json');

class LocalBrain {
    constructor() {
        this.network = null;
        this.isLoaded = false;
        this.loadModel();
    }

    loadModel() {
        if (!fs.existsSync(MODEL_PATH)) {
            console.log('[LocalBrain] Pas de modèle trouvé. Lance scripts/train.js après avoir enregistré des données.');
            return;
        }

        try {
            const modelData = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
            this.network = Network.fromJSON(modelData.network);
            this.isLoaded = true;

            const age = Math.round((Date.now() - new Date(modelData.trainedAt).getTime()) / 1000 / 60);
            console.log(`[LocalBrain] Modèle chargé (${modelData.examples} exemples, ${modelData.accuracy}% précision, entraîné il y a ${age} min)`);
        } catch (e) {
            console.log(`[LocalBrain] Erreur chargement modèle: ${e.message}`);
        }
    }

    async decideNextTask(botState) {
        // Interface identique à Brain.js pour être interchangeable

        if (!this.isLoaded) {
            return null; // Pas de modèle → fallback state machine
        }

        try {
            // Encoder l'état (on reçoit botState comme string, mais LocalBrain
            // peut être appelé avec le bot directement si on adapte Agent.js)
            // Ici on supporte les deux modes
            let inputVector;

            if (botState._bot) {
                // Mode direct : botState contient le bot
                inputVector = encodeState(botState._bot);
            } else {
                // Mode dégradé : on ne peut pas encoder sans le bot
                // Retourne null pour fallback sur state machine
                return null;
            }

            const output = this.network.activate(inputVector);
            const actionName = decodeAction(output);

            // Confidence = valeur max de l'output (softmax approximé)
            const maxVal = Math.max(...output);
            const confidence = (maxVal * 100).toFixed(0);

            console.log(`[LocalBrain] Décision: ${actionName} (confiance: ${confidence}%)`);

            // Ne proposer que si confiance suffisante
            if (maxVal < 0.3) {
                console.log(`[LocalBrain] Confiance trop faible (${confidence}%), fallback state machine.`);
                return null;
            }

            // Convertir l'action en format compatible avec executeAiCommand
            return this.actionToCommand(actionName);

        } catch (e) {
            console.log(`[LocalBrain] Erreur inférence: ${e.message}`);
            return null;
        }
    }

    actionToCommand(actionName) {
        // Mapper les noms d'actions Recorder vers les commandes Agent
        const mapping = {
            'GetWood':            { action: 'GetWood', args: [3] },
            'CraftPlanks':        { action: 'CraftTask', args: ['oak_planks', 8] },
            'CraftCraftingTable': { action: 'CraftTask', args: ['crafting_table', 1] },
            'CraftStick':         { action: 'CraftTask', args: ['stick', 4] },
            'CraftWoodenPickaxe': { action: 'CraftTask', args: ['wooden_pickaxe', 1] },
            'MineStone':          { action: 'MineBlock', args: ['stone', 3] },
            'CraftStonePickaxe':  { action: 'CraftTask', args: ['stone_pickaxe', 1] },
            'CraftStoneSword':    { action: 'CraftTask', args: ['stone_sword', 1] },
            'MineIronOre':        { action: 'MineBlock', args: ['iron_ore', 6] },
            'CraftFurnace':       { action: 'CraftTask', args: ['furnace', 1] },
            'SmeltIron':          { action: 'SmeltTask', args: ['raw_iron', 'iron_ingot', 6] },
            'CraftIronPickaxe':   { action: 'CraftTask', args: ['iron_pickaxe', 1] },
            'CraftIronSword':     { action: 'CraftTask', args: ['iron_sword', 1] },
            'MineCoal':           { action: 'MineBlock', args: ['coal_ore', 3] },
            'DigDown':            { action: 'MineBlock', args: ['diamond_ore', 3] },
            'MineObsidian':       { action: 'MineBlock', args: ['obsidian', 10] },
            'MineGravel':         { action: 'MineBlock', args: ['gravel', 5] },
            'CraftFlintAndSteel': { action: 'CraftTask', args: ['flint_and_steel', 1] },
            'BuildNetherPortal':  { action: 'BuildNetherPortal', args: [] },
            'FightBlaze':         { action: 'FightMob', args: ['blaze', 6] },
            'FightEnderman':      { action: 'FightMob', args: ['enderman', 12] },
            'CraftBlazePowder':   { action: 'CraftTask', args: ['blaze_powder', 6] },
            'CraftEyeOfEnder':    { action: 'CraftTask', args: ['ender_eye', 12] },
            'MoveToSurface':      { action: 'MoveToSurface', args: [] },
        };

        const cmd = mapping[actionName];
        if (!cmd) return null;

        return {
            thought: `LocalBrain recommande ${actionName}`,
            action: cmd.action,
            args: cmd.args
        };
    }

    isAvailable() {
        return this.isLoaded;
    }
}

module.exports = LocalBrain;
