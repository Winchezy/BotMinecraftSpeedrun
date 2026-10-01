const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const pvp = require('mineflayer-pvp').plugin;
const armorManager = require('mineflayer-armor-manager');
const Agent = require('./Agent');

function createBot(host, port, username, options = {}) {
    const bot = mineflayer.createBot({
        host: host,
        port: port,
        username: username,
        version: false,
        auth: 'offline',
        hideErrors: false,
        chatSigning: false,
        checkTimeoutInterval: 240 * 1000
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(pvp);
    bot.loadPlugin(armorManager);

    bot.once('spawn', async () => {
        console.log('Bot spawned! Waiting for chunks to load...');

        // Attendre que les chunks autour du bot soient chargés
        await bot.waitForChunksToLoad();
        console.log('Chunks loaded! Initializing Agent...');

        const mcData = require('minecraft-data')(bot.version);

        // Setup survival (anti-drown, respawn, etc.)
        const { setupSurvival, configurePathfinder } = require('./lib/Survival');
        setupSurvival(bot);
        configurePathfinder(bot);

        const agent = new Agent(bot);

        if (options.trainWood) {
            loopTrainWood(bot, agent);
        } else {
            loop(bot, agent);
        }
    });

    bot.on('kicked', (reason) => {
        console.log('[Bot] Kicked:', reason);
        require('./lib/WoodBrain').getInstance().saveAll();
    });
    bot.on('error', console.log);
}

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

async function loopTrainWood(bot, agent) {
    const { getInstance } = require('./lib/WoodBrain');
    const GetWood = require('./tasks/GetWood');
    const TARGET_EXAMPLES = 30;

    console.log('[TrainMode] Démarrage collecte WoodBrain...');

    while (true) {
        const brain = getInstance();
        if (brain.dataset.length >= TARGET_EXAMPLES) {
            brain.saveAll();
            console.log(`[TrainMode] ${TARGET_EXAMPLES} exemples atteints ! Lance: node scripts/train_wood.js`);
            break;
        }

        const task = new GetWood(bot, 10);
        try {
            while (!task.isDone()) {
                await task.run();
                try { await bot.waitForTicks(5); } catch(e) {}
            }
        } catch (err) {
            console.log('[TrainMode] Erreur GetWood:', err.message);
        }

        // Jeter les logs pour repartir à 0 au prochain run
        for (const item of bot.inventory.items()) {
            if (item.name.includes('log') && !item.name.includes('stripped')) {
                try { await bot.toss(item.type, null, item.count); } catch(e) {}
            }
        }

        try { await bot.waitForTicks(20); } catch(e) {}
    }
}

async function loop(bot, agent) {
    while (true) {
        try {
            await agent.tick();
        } catch (err) {
            console.log('\n[!] Task Error:', err.message || err);
            try { await bot.waitForTicks(5); } catch(e) {}
        }
        try { await bot.waitForTicks(5); } catch(e) {} // Pause between ticks
    }
}

module.exports = { createBot };
