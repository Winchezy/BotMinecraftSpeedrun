// train_wood.js - Entraîne le réseau de neurones pour la coupe d'arbres (WoodBrain)
// Usage: node scripts/train_wood.js
//
// Données générées automatiquement dans data/wood_dataset.json quand le bot joue.

const { Architect, Trainer } = require('synaptic');
const fs   = require('fs');
const path = require('path');

const { WOOD_ACTIONS } = require('../src/lib/WoodBrain');

const DATASET_PATH = path.join(__dirname, '../data/wood_dataset.json');
const MODEL_PATH   = path.join(__dirname, '../data/wood_model.json');
const INPUT_SIZE   = 10;

console.log('\n==================================================');
console.log('=== Entraînement WoodBrain (coupe d\'arbres)  ===');
console.log('==================================================');

if (!fs.existsSync(DATASET_PATH)) {
    console.log(`⚠️  Pas de données (${DATASET_PATH})`);
    console.log('   Lance le bot pour générer des données automatiquement.\n');
    process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
console.log(`📂 Chargement: ${rawData.length} exemples bruts`);

const data = rawData.filter(d =>
    d.input && d.output &&
    d.input.length === INPUT_SIZE &&
    d.output.length === WOOD_ACTIONS.length
);

console.log(`✓  Valides: ${data.length} exemples`);

if (data.length < 15) {
    console.log(`❌ Pas assez de données (minimum 15, actuellement ${data.length}).`);
    console.log('   Continue à faire jouer le bot pour générer plus de données.\n');
    process.exit(1);
}

// Distribution des actions
const counts = {};
for (const d of data) {
    const idx  = d.output.indexOf(Math.max(...d.output));
    const name = WOOD_ACTIONS[idx] || `action_${idx}`;
    counts[name] = (counts[name] || 0) + 1;
}
console.log('\n📊 Distribution:');
for (const [action, count] of Object.entries(counts)) {
    const pct = ((count / data.length) * 100).toFixed(1);
    console.log(`   ${action.padEnd(18)}: ${count} (${pct}%)`);
}

// Mélanger
for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j], data[i]];
}

const splitIdx  = data.length > 20 ? Math.floor(data.length * 0.8) : data.length;
const trainData = data.slice(0, splitIdx);
const valData   = data.slice(splitIdx);

console.log(`\n🏋️  Train: ${trainData.length}, Validation: ${valData.length}`);
console.log('Architecture: 10 → 8 → 3\n');

const network = new Architect.Perceptron(INPUT_SIZE, 8, WOOD_ACTIONS.length);
const trainer  = new Trainer(network);

const result = trainer.train(trainData, {
    rate:       0.03,
    iterations: 10000,
    error:      0.01,
    shuffle:    true,
    log:        500,
    cost:       Trainer.cost.CROSS_ENTROPY
});

console.log(`\n✓ Terminé en ${result.iterations} itérations (erreur: ${result.error.toFixed(5)})`);

// Validation
let correct = 0;
for (const example of valData) {
    const output    = network.activate(example.input);
    const predicted = output.indexOf(Math.max(...output));
    const expected  = example.output.indexOf(Math.max(...example.output));
    if (predicted === expected) correct++;
}

const accuracy = valData.length > 0
    ? ((correct / valData.length) * 100).toFixed(1)
    : '100.0';

console.log(`📈 Précision validation: ${accuracy}%`);
if      (parseFloat(accuracy) < 50) console.log('⚠️  Faible précision — génère plus de données');
else if (parseFloat(accuracy) < 75) console.log('✓  Précision correcte');
else                                 console.log('✓✓ Bonne précision !');

const modelData = {
    network:    network.toJSON(),
    actions:    WOOD_ACTIONS,
    inputSize:  INPUT_SIZE,
    outputSize: WOOD_ACTIONS.length,
    trainedAt:  new Date().toISOString(),
    examples:   data.length,
    accuracy:   parseFloat(accuracy)
};

fs.writeFileSync(MODEL_PATH, JSON.stringify(modelData, null, 2));
console.log(`\n💾 Modèle sauvegardé: ${MODEL_PATH}`);
console.log('✅ Relance le bot pour utiliser le modèle.\n');
