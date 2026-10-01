// train.js - Entraîne le réseau de neurones sur le dataset généré par le Recorder
// Usage : node scripts/train.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { Architect, Trainer } = require('synaptic');
const { ACTIONS } = require('../src/Recorder');

const DATASET_PATH = path.join(__dirname, '../data/dataset.json');
const MODEL_PATH = path.join(__dirname, '../data/model.json');

// ==================== CHARGEMENT DU DATASET ====================

if (!fs.existsSync(DATASET_PATH)) {
    console.error('[Train] Pas de dataset trouvé. Lance recorder.js d\'abord.');
    process.exit(1);
}

const rawDataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
console.log(`[Train] Dataset chargé : ${rawDataset.length} exemples`);

// Filtrer les exemples invalides
const dataset = rawDataset.filter(d =>
    d.input && d.output &&
    d.input.length > 0 &&
    d.output.length === ACTIONS.length
);

console.log(`[Train] Exemples valides : ${dataset.length}`);

if (dataset.length < 10) {
    console.error('[Train] Pas assez d\'exemples (minimum 10). Continue à enregistrer avec recorder.js.');
    process.exit(1);
}

// Stats par action
const actionCounts = {};
dataset.forEach(d => {
    const idx = d.output.indexOf(1);
    const action = ACTIONS[idx] || 'unknown';
    actionCounts[action] = (actionCounts[action] || 0) + 1;
});

console.log('\n[Train] Distribution des actions :');
Object.entries(actionCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([action, count]) => {
        const bar = '█'.repeat(Math.floor(count / Math.max(...Object.values(actionCounts)) * 20));
        console.log(`  ${action.padEnd(25)} ${count.toString().padStart(4)} ${bar}`);
    });

// ==================== ARCHITECTURE DU RÉSEAU ====================

const INPUT_SIZE = dataset[0].input.length;
const OUTPUT_SIZE = ACTIONS.length;
const HIDDEN_SIZE = 32; // Réduit drastiquement pour accélérer (32 au lieu de 99)

console.log(`\n[Train] Architecture : ${INPUT_SIZE} → ${HIDDEN_SIZE} → ${OUTPUT_SIZE}`);

// Réseau feedforward : entrée → couche cachée → sortie
const network = new Architect.Perceptron(INPUT_SIZE, HIDDEN_SIZE, OUTPUT_SIZE);

// ==================== ENTRAÎNEMENT ====================

// Mélanger le dataset pour éviter le biais d'ordre
const shuffled = [...dataset].sort(() => Math.random() - 0.5);

// Split train/validation
let trainSet = shuffled;
let valSet = shuffled;

// Activer le vrai split uniquement quand on a un dataset conséquent pour éviter
// d'envoyer nos actions uniques (ex: 1 seul log de "CraftFurnace") dans le 
// set de validation sans jamais pouvoir l'apprendre.
if (shuffled.length > 100) {
    const splitIdx = Math.floor(shuffled.length * 0.8);
    trainSet = shuffled.slice(0, splitIdx);
    valSet = shuffled.slice(splitIdx);
}

console.log(`[Train] Train: ${trainSet.length} | Validation: ${valSet.length}`);

const trainingData = trainSet.map(d => ({
    input: d.input,
    output: d.output
}));

const trainer = new Trainer(network);

console.log('\n[Train] Entraînement en cours...\n');

const result = trainer.train(trainingData, {
    rate: 0.1,
    iterations: 2000,
    error: 0.01,
    shuffle: true,
    log: 500,
    cost: Trainer.cost.MSE
});

console.log(`\n[Train] Terminé !`);
console.log(`  Itérations : ${result.iterations}`);
console.log(`  Erreur finale : ${result.error.toFixed(6)}`);

// ==================== VALIDATION ====================

let correct = 0;
valSet.forEach(d => {
    const output = network.activate(d.input);
    const predicted = output.indexOf(Math.max(...output));
    const expected = d.output.indexOf(1);
    if (predicted === expected) correct++;
});

const accuracy = (correct / valSet.length * 100).toFixed(1);
console.log(`\n[Train] Précision validation : ${accuracy}% (${correct}/${valSet.length})`);

if (parseFloat(accuracy) < 50) {
    console.log('[Train] ⚠ Précision faible. Essaie d\'enregistrer plus d\'exemples variés.');
} else if (parseFloat(accuracy) < 75) {
    console.log('[Train] ✓ Précision correcte. Plus de données amélioreraient le modèle.');
} else {
    console.log('[Train] ✓ Bonne précision !');
}

// ==================== SAUVEGARDE DU MODÈLE ====================

const modelData = {
    network: network.toJSON(),
    actions: ACTIONS,
    inputSize: INPUT_SIZE,
    outputSize: OUTPUT_SIZE,
    trainedAt: new Date().toISOString(),
    examples: dataset.length,
    accuracy: parseFloat(accuracy)
};

fs.writeFileSync(MODEL_PATH, JSON.stringify(modelData, null, 2));
console.log(`\n[Train] Modèle sauvegardé → ${MODEL_PATH}`);
console.log('[Train] Tu peux maintenant utiliser LocalBrain dans le bot.');
