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
        require('./lib/Pathing').makeIdleStopImmediate(bot);
        bot.actions = new (require('./lib/ActionController'))(bot);
        const { setupSurvival, configurePathfinder } = require('./lib/Survival');
        setupSurvival(bot);
        configurePathfinder(bot);
        // Trace du chemin parcouru sous terre, pour que MoveToSurface la reprenne.
        require('./lib/Trail').attachTrail(bot);

        const agent = new Agent(bot);
        bot.behaviorObserver = new (require('./lib/BehaviorObserver'))(bot, agent);

        loop(bot, agent);
    });

    bot.on('kicked', console.log);
    bot.on('error', console.log);
    const memoryTimer = setInterval(() => {
        const memory = process.memoryUsage();
        console.log(`[Memory] heap=${Math.round(memory.heapUsed / 1048576)}MB rss=${Math.round(memory.rss / 1048576)}MB`);
    }, 30000);
    bot.once('end', () => clearInterval(memoryTimer));
    return bot;
}

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
});

async function loop(bot, agent) {
    let connected = true;
    bot.once('end', () => { connected = false; });
    while (connected) {
        try {
            if (bot.isInCombat?.()) agent.combatPreparation.noteBlocked();
            await bot.actions.run('agent', 20, () => agent.tick());
        } catch (err) {
            console.error('Agent error:', err);
            await bot.waitForTicks(5);
        }
        if (connected) await bot.waitForTicks(2);
    }
}

module.exports = { createBot };
