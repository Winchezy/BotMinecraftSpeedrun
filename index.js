const fs = require('fs');
const path = require('path');
const { createBot } = require('./src/bot');

// --- Redirection des logs vers fichiers + console ---
const logFile = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'w' });
const debugLogFile = fs.createWriteStream(path.join(__dirname, 'bot_debug.log'), { flags: 'w' });

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    const msg = `[${timestamp}] ${args.join(' ')}`;
    originalLog.apply(console, args);
    logFile.write(msg + '\n');
    debugLogFile.write(msg + '\n');
};

console.error = (...args) => {
    const timestamp = new Date().toISOString().substring(11, 19);
    const msg = `[${timestamp}] [ERROR] ${args.join(' ')}`;
    originalError.apply(console, args);
    logFile.write(msg + '\n');
    debugLogFile.write(msg + '\n');
};

// Arguments de ligne de commande pour host/port/username
const args2 = process.argv.slice(2);
let host = args2[0] || 'localhost';
const port = parseInt(args2[1]) || 25565;
const username = args2[2] || 'SpeedrunBot';
const trainWood = args2.includes('--train-wood');

if (trainWood) {
    console.log('[TrainMode] Mode collecte WoodBrain actif — le bot va boucler sur GetWood jusqu\'à 30 exemples.');
}

console.log(`Starting bot on ${host}:${port} as ${username}`);
createBot(host, port, username, { trainWood });
