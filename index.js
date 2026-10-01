const { createBot } = require('./src/bot');

// Arguments de ligne de commande pour host/port/username
const args = process.argv.slice(2);
let host = args[0] || '127.0.0.1';
if (host === 'localhost') host = '127.0.0.1'; // Force IPv4
// Le bot rejoint un monde cree dans le jeu et ouvert en LAN : son port change a
// chaque ouverture, il n'y a donc pas de port par defaut.
const port = parseInt(args[1]);
if (!port) {
    console.error('Port manquant. Dans Minecraft : Echap > Ouvrir au LAN (triche activee),');
    console.error('puis relancez avec le port affiche dans le chat :');
    console.error('  node index.js localhost <PORT> [NomDuBot]');
    process.exit(1);
}
const username = args[2] || 'SpeedrunBot';

console.log(`Starting bot on ${host}:${port} as ${username}`);
const bot = createBot(host, port, username);
// Le superviseur peut deconnecter proprement son propre joueur avant une relance.
process.on('message', message => {
    if (message?.type !== 'shutdown') return;
    bot.behaviorObserver?.stop();
    bot.quit('Relance par le superviseur');
    setTimeout(() => process.exit(0), 500).unref();
});
