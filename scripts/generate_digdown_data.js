// generate_digdown_data.js
// Génère des données d'entraînement synthétiques pour DigDown
// en appliquant les règles déterministes sur toutes les combinaisons d'états.
// Aucun serveur Minecraft requis — s'exécute en quelques secondes.
//
// Usage: node scripts/generate_digdown_data.js [--count 2000] [--merge]
//   --count N  : nombre d'exemples à générer (défaut: 2000)
//   --merge    : fusionner avec le dataset existant (défaut: remplacer)

const fs   = require('fs');
const path = require('path');

const DATASET_PATH = path.join(__dirname, '../data/digdown_dataset.json');
const DIGDOWN_ACTIONS = ['DIG_HEAD', 'DIG_BODY', 'DIG_FLOOR', 'DIG_UNDER', 'MOVE_FORWARD', 'TURN_AND_STOP'];

const args    = process.argv.slice(2);
const COUNT   = parseInt(args[args.indexOf('--count') + 1] || '2000');
const MERGE   = args.includes('--merge');

// ── Règles déterministes (miroir de _runStaircase dans DigDown.js) ──────────
function ruleDecide(f) {
    const [
        /*0*/ yNorm, /*1*/ targetYNorm, /*2*/ yProgress,
        /*3*/ headSolid, /*4*/ bodySolid, /*5*/ floorSolid,
        /*6*/ floor2Solid, /*7*/ floor2Liquid, /*8*/ floor2Void,
        /*9*/ hasBridge, /*10*/ hasPickaxe,
        /*11*/ diamondNearby, /*12*/ stuckNorm, /*13*/ liquidNearby
    ] = f;

    // Pas de pioche ou liquide dangereux → s'arrêter/tourner
    if (!hasPickaxe)     return 'TURN_AND_STOP';
    if (liquidNearby)    return 'TURN_AND_STOP';
    if (floor2Liquid)    return 'TURN_AND_STOP';

    // Priorité 1 : dégager la tête
    if (headSolid)  return 'DIG_HEAD';

    // Priorité 2 : dégager le corps
    if (bodySolid)  return 'DIG_BODY';

    // Priorité 3 : creuser le sol (escalier)
    if (floorSolid) {
        if (floor2Void && !hasBridge) return 'TURN_AND_STOP'; // vide non comblable
        return 'DIG_FLOOR';
    }

    // Priorité 4 : creuser sous soi (si bloqué depuis longtemps)
    if (stuckNorm > 0.5) return 'DIG_UNDER';

    // Priorité 5 : avancer (voie libre)
    return 'MOVE_FORWARD';
}

// ── Générateur d'exemples aléatoires ────────────────────────────────────────
function randomFeatures() {
    // Répartition réaliste des profondeurs
    const yNorm      = Math.random();
    const targetYNorm = Math.random() * 0.3; // cible souvent profonde
    const yProgress  = Math.random();

    // Combinaisons de blocs cohérentes
    const headSolid  = Math.random() < 0.45;
    const bodySolid  = headSolid ? Math.random() < 0.7 : Math.random() < 0.25;
    const floorSolid = (!headSolid && !bodySolid) ? Math.random() < 0.6 : Math.random() < 0.35;

    // Sol sous le prochain bloc (mutuellement exclusifs)
    const r = Math.random();
    const floor2Solid  = r < 0.65 ? 1 : 0;
    const floor2Liquid = !floor2Solid && r < 0.75 ? 1 : 0;
    const floor2Void   = !floor2Solid && !floor2Liquid ? 1 : 0;

    const hasBridge      = Math.random() < 0.7  ? 1 : 0;
    const hasPickaxe     = Math.random() < 0.95 ? 1 : 0;
    const diamondNearby  = Math.random() < 0.05 ? 1 : 0;
    const stuckNorm      = Math.random() < 0.15 ? Math.random() : 0;
    const liquidNearby   = Math.random() < 0.08 ? 1 : 0;

    return [
        yNorm, targetYNorm, yProgress,
        headSolid  ? 1 : 0,
        bodySolid  ? 1 : 0,
        floorSolid ? 1 : 0,
        floor2Solid, floor2Liquid, floor2Void,
        hasBridge, hasPickaxe,
        diamondNearby,
        stuckNorm,
        liquidNearby
    ];
}

// ── Génération ───────────────────────────────────────────────────────────────
console.log(`Génération de ${COUNT} exemples synthétiques...`);

const counts = {};
DIGDOWN_ACTIONS.forEach(a => counts[a] = 0);

const generated = [];
for (let i = 0; i < COUNT; i++) {
    const input  = randomFeatures();
    const action = ruleDecide(input);
    const output = new Array(DIGDOWN_ACTIONS.length).fill(0);
    output[DIGDOWN_ACTIONS.indexOf(action)] = 1;
    generated.push({ input, output, action, synthetic: true, timestamp: Date.now() });
    counts[action]++;
}

// Distribution
console.log('\nDistribution :');
DIGDOWN_ACTIONS.forEach(a => {
    const pct = ((counts[a] / COUNT) * 100).toFixed(1);
    console.log(`  ${a.padEnd(16)}: ${counts[a]} (${pct}%)`);
});

// Fusion ou remplacement
let final = generated;
if (MERGE && fs.existsSync(DATASET_PATH)) {
    const existing = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
    // Conserver uniquement les exemples réels (pas synthétiques) déjà présents
    const real = existing.filter(d => !d.synthetic);
    final = [...real, ...generated];
    console.log(`\nFusion : ${real.length} réels + ${generated.length} synthétiques = ${final.length} total`);
} else {
    console.log(`\nRemplacement du dataset (${COUNT} exemples synthétiques)`);
}

const tmp = DATASET_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(final, null, 2));
fs.renameSync(tmp, DATASET_PATH);
console.log(`\n✓ Dataset sauvegardé : ${DATASET_PATH}`);
console.log('  Lance maintenant : node scripts/train_digdown.js');
