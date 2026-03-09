const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const pvp = require('mineflayer-pvp').plugin;
const armorManager = require('mineflayer-armor-manager');
const Agent = require('./Agent');

function createBot(host, port, username) {
    const bot = mineflayer.createBot({
        host: host,
        port: port,
        username: username,
        version: "1.20.4",
        hideErrors: false
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(pvp);
    bot.loadPlugin(armorManager);

    bot.once('spawn', () => {
        console.log('Bot spawned! Initializing Agent...');
        const mcData = require('minecraft-data')(bot.version);

        // Setup survival (anti-drown, respawn, etc.)
        const { setupSurvival, configurePathfinder } = require('./lib/Survival');
        setupSurvival(bot);
        configurePathfinder(bot);

        const agent = new Agent(bot);

        loop(bot, agent);
    });

    bot.on('kicked', console.log);
    bot.on('error', console.log);
}

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

async function loop(bot, agent) {
    while (true) {
        try {
            await agent.tick();
        } catch (err) {
            console.error('Agent error:', err);
            await bot.waitForTicks(5);
        }
        await bot.waitForTicks(5); // Reduced from 20 to 5 ticks for faster execution
    }
}

module.exports = { createBot };
