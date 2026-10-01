require('dotenv').config();
const { startRecorder } = require('./src/Recorder');

process.on('uncaughtException', (err) => {
    console.error('[CRASH PREVENTED] UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[CRASH PREVENTED] UNHANDLED REJECTION:', err);
});

const args = process.argv.slice(2);
const host = args[0] || 'localhost';
// Monde ouvert en LAN depuis le jeu : le port change a chaque ouverture.
const port = parseInt(args[1]);
if (!port) {
    console.error('Port manquant : node recorder.js localhost <PORT> (port affiche apres "Ouvrir au LAN").');
    process.exit(1);
}

console.log(`Démarrage du Recorder sur ${host}:${port}`);
console.log('Commandes disponibles dans le chat Minecraft :');
console.log('  !do <action> [arg1] [arg2]  - Enseigner une action');
console.log('  !status                      - Voir l\'état actuel');
console.log('  !undo                        - Supprimer le dernier exemple');
console.log('  !save                        - Sauvegarder maintenant');
console.log('  !actions                     - Liste des actions disponibles');

startRecorder(host, port);
