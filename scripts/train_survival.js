// train_survival.js - Entraîne le réseau de neurones de survie
// Usage: node scripts/train_survival.js
//
// Nécessite des données générées automatiquement par le bot (data/survival_dataset.json).
// Lance le bot pendant quelques minutes, puis exécute ce script.

const { Architect, Trainer } = require('synaptic');
const fs   = require('fs');
const path = require('path');

const DATASET_PATH = path.join(__dirname, '../data/survival_dataset.json');
const MODEL_PATH   = path.join(__dirname, '../data/survival_model.json');

const { SURVIVAL_ACTIONS } = require('../src/lib/SurvivalBrain');

// ── Chargement des données ────────────────────────────────────────────────────

if (!fs.existsSync(DATASET_PATH)) {
    console.error('❌ Aucune donnée d\'entraînement (data/survival_dataset.json).');
    console.error('   Lance le bot pendant quelques minutes pour générer des données automatiquement.');
    process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
console.log(`📂 Chargement: ${rawData.length} exemples bruts`);

const data = rawData.filter(d =>
    d.input && d.output &&
    d.input.length === 18 &&
    d.output.length === SURVIVAL_ACTIONS.length
);

console.log(`✓  Valides: ${data.length} exemples`);

if (data.length < 20) {
    console.error(`❌ Pas assez de données (minimum 20, actuellement ${data.length}).`);
    console.error('   Continue à jouer pour générer plus d\'exemples.');
    process.exit(1);
}

// Distribution des actions
const actionCounts = {};
for (const d of data) {
    const idx = d.output.indexOf(Math.max(...d.output));
    const name = SURVIVAL_ACTIONS[idx] || `action_${idx}`;
    actionCounts[name] = (actionCounts[name] || 0) + 1;
}
console.log('\n📊 Distribution des actions:');
for (const [action, count] of Object.entries(actionCounts)) {
    const pct = ((count / data.length) * 100).toFixed(1);
    console.log(`   ${action.padEnd(16)}: ${count} (${pct}%)`);
}

// ── Split train/validation ────────────────────────────────────────────────────

// Mélange
for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j], data[i]];
}

const splitIdx  = Math.floor(data.length * 0.8);
const trainData = data.slice(0, splitIdx);
const valData   = data.slice(splitIdx);

console.log(`\n🏋️  Train: ${trainData.length}, Validation: ${valData.length}`);

// ── Entraînement ──────────────────────────────────────────────────────────────

// Architecture: 18 entrées → 24 cachés → 12 cachés → 7 sorties
const network = new Architect.Perceptron(18, 24, 12, SURVIVAL_ACTIONS.length);
const trainer = new Trainer(network);

console.log('\n=== Entraînement SurvivalBrain ===');
console.log('Architecture: 18 → 24 → 12 → 7\n');

const result = trainer.train(trainData, {
    rate:       0.05,
    iterations: 3000,
    error:      0.005,
    shuffle:    true,
    log:        500,
    cost:       Trainer.cost.CROSS_ENTROPY
});

console.log(`\n✓ Entraînement terminé en ${result.iterations} itérations (erreur: ${result.error.toFixed(5)})`);

// ── Validation ────────────────────────────────────────────────────────────────

let correct = 0;
const confusionMatrix = {};

for (const example of valData) {
    const output     = network.activate(example.input);
    const predicted  = output.indexOf(Math.max(...output));
    const expected   = example.output.indexOf(Math.max(...example.output));
    const predName   = SURVIVAL_ACTIONS[predicted];
    const expName    = SURVIVAL_ACTIONS[expected];

    if (predicted === expected) correct++;

    // Matrice de confusion simplifiée
    const key = `${expName}→${predName}`;
    confusionMatrix[key] = (confusionMatrix[key] || 0) + 1;
}

const accuracy = valData.length > 0
    ? ((correct / valData.length) * 100).toFixed(1)
    : '100.0';

console.log(`\n📈 Précision validation: ${accuracy}%`);

if (parseFloat(accuracy) < 50)      console.log('⚠️  Faible précision – besoin de plus de données variées');
else if (parseFloat(accuracy) < 75) console.log('✓  Précision correcte');
else                                 console.log('✓✓ Bonne précision !');

// Erreurs fréquentes
const errors = Object.entries(confusionMatrix)
    .filter(([k]) => !k.split('→').every((v, i, a) => v === a[0]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

if (errors.length > 0) {
    console.log('\n🔍 Erreurs fréquentes:');
    for (const [pair, count] of errors) {
        console.log(`   ${pair}: ${count}x`);
    }
}

// ── Sauvegarde ────────────────────────────────────────────────────────────────

const modelData = {
    network:    network.toJSON(),
    actions:    SURVIVAL_ACTIONS,
    inputSize:  18,
    outputSize: SURVIVAL_ACTIONS.length,
    trainedAt:  new Date().toISOString(),
    examples:   data.length,
    accuracy:   parseFloat(accuracy)
};

fs.writeFileSync(MODEL_PATH, JSON.stringify(modelData, null, 2));
console.log(`\n💾 Modèle sauvegardé: ${MODEL_PATH}`);
console.log('   Relance le bot pour utiliser le nouveau modèle.');
