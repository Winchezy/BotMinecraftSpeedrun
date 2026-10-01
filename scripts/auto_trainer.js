// auto_trainer.js — Entraînement automatique en arrière-plan
//
// Ce script tourne en parallèle des bots. Il surveille les datasets,
// fusionne les fichiers de chaque bot, et déclenche l'entraînement
// dès qu'un seuil de nouveaux exemples est atteint.
//
// Usage: node scripts/auto_trainer.js
//
// Paramètres ajustables :
const CHECK_INTERVAL_MS   = 30_000;  // vérification toutes les 30 secondes
const NEW_EXAMPLES_NEEDED = 20;      // nouveaux exemples requis pour réentraîner
const FORCE_RETRAIN_MS    = 60_000;  // réentraînement forcé toutes les 60s si assez de données

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR     = path.join(__dirname, '../data');
const SCRIPTS_DIR  = __dirname;

// Datasets à surveiller : { pattern de fichiers bot, dataset fusionné, script d'entraînement, min exemples }
const TARGETS = [
    {
        name:       'DigDown',
        pattern:    'digdown_dataset',
        merged:     path.join(DATA_DIR, 'digdown_dataset.json'),
        trainScript: path.join(SCRIPTS_DIR, 'train_digdown.js'),
        minExamples: 20,
    },
    {
        name:       'MoveToSurface',
        pattern:    'surface_dataset',
        merged:     path.join(DATA_DIR, 'surface_dataset.json'),
        trainScript: path.join(SCRIPTS_DIR, 'train_surface.js'),
        minExamples: 10,
    },
    {
        name:       'Wood',
        pattern:    'wood_dataset',
        merged:     path.join(DATA_DIR, 'wood_dataset.json'),
        trainScript: path.join(SCRIPTS_DIR, 'train_wood.js'),
        minExamples: 20,
    },
    {
        name:       'Survival',
        pattern:    'survival_dataset',
        merged:     path.join(DATA_DIR, 'survival_dataset.json'),
        trainScript: path.join(SCRIPTS_DIR, 'train_survival.js'),
        minExamples: 10,
    },
];

// État par target : combien d'exemples au dernier entraînement
const lastTrainCount  = {};
const lastTrainTime   = {};
TARGETS.forEach(t => { lastTrainCount[t.name] = 0; lastTrainTime[t.name] = 0; });

// ── Fusion des fichiers bot → dataset principal ────────────────────────────

function mergeDatasets(target) {
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith(target.pattern) && f.endsWith('.json') && !f.endsWith('.tmp'))
        .filter(f => f !== path.basename(target.merged)); // exclure le fichier fusionné lui-même

    // Lire tous les fichiers bot
    const allExamples = new Map(); // clé = JSON(input) pour dédupliquer
    const botFiles = [];

    // D'abord charger le dataset fusionné existant
    if (fs.existsSync(target.merged)) {
        const existing = JSON.parse(fs.readFileSync(target.merged, 'utf-8'));
        existing.forEach(ex => allExamples.set(JSON.stringify(ex.input), ex));
    }

    // Ensuite fusionner les fichiers bot
    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            data.forEach(ex => allExamples.set(JSON.stringify(ex.input), ex));
            botFiles.push(filePath);
        } catch { /* Fichier corrompu ou en cours d'écriture, on l'ignore */ }
    }

    const merged = Array.from(allExamples.values());

    if (merged.length === 0) return false;

    // Sauvegarder le dataset fusionné seulement si des fichiers bot ont apporté du nouveau
    if (files.length > 0) {
        const tmp = target.merged + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
        fs.renameSync(tmp, target.merged);
        console.log(`[AutoTrainer] ${target.name}: fusionné ${files.length} fichier(s) bot → ${merged.length} exemples uniques`);
    }

    return merged.length;
}

// ── Entraînement ──────────────────────────────────────────────────────────

function train(target, totalExamples) {
    console.log(`\n[AutoTrainer] ⚡ Entraînement ${target.name} (${totalExamples} exemples)...`);
    try {
        execSync(`node "${target.trainScript}"`, { stdio: 'inherit' });
        lastTrainCount[target.name] = totalExamples;
        lastTrainTime[target.name]  = Date.now();
        console.log(`[AutoTrainer] ✓ ${target.name} entraîné avec succès\n`);
    } catch (e) {
        console.log(`[AutoTrainer] ✗ Erreur entraînement ${target.name}: ${e.message}\n`);
    }
}

// ── Boucle principale ─────────────────────────────────────────────────────

function check() {
    const now = Date.now();

    for (const target of TARGETS) {
        const total = mergeDatasets(target);
        if (total === false || total < target.minExamples) continue;

        const newSinceLast  = total - lastTrainCount[target.name];
        const timeSinceLast = now   - lastTrainTime[target.name];

        const shouldTrain =
            (newSinceLast >= NEW_EXAMPLES_NEEDED) ||
            (timeSinceLast >= FORCE_RETRAIN_MS && total > lastTrainCount[target.name]);

        if (shouldTrain) {
            train(target, total);
        } else if (newSinceLast > 0) {
            console.log(`[AutoTrainer] ${target.name}: +${newSinceLast} nouveaux exemples (${total} total, seuil: ${NEW_EXAMPLES_NEEDED})`);
        }
    }
}

// ── Démarrage ─────────────────────────────────────────────────────────────

console.log('='.repeat(50));
console.log('=== AutoTrainer démarré ===');
console.log(`Vérification toutes les ${CHECK_INTERVAL_MS / 1000}s`);
console.log(`Seuil de réentraînement : +${NEW_EXAMPLES_NEEDED} exemples`);
console.log(`Réentraînement forcé toutes les ${FORCE_RETRAIN_MS / 1000}s`);
console.log('='.repeat(50) + '\n');

// Première vérification immédiate
check();

// Puis en boucle
setInterval(check, CHECK_INTERVAL_MS);
