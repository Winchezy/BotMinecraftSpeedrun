// Recorder.js - Mode imitation learning
// Le bot se connecte, affiche son état, et attend que le joueur humain lui dise quoi faire via le chat.
// Chaque commande génère un exemple (état → action) dans le dataset.
//
// Usage : node recorder.js localhost <PORT>
// Commandes chat disponibles : !do <action> [arg1] [arg2]
// Exemples :
//   !do GetWood
//   !do CraftTask oak_planks 8
//   !do MineBlock stone 3
//   !do MoveToSurface
//   !do status    -> affiche l'état actuel sans enregistrer
//   !undo         -> supprime le dernier exemple (correction d'erreur)

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const pvp = require('mineflayer-pvp').plugin;
const armorManager = require('mineflayer-armor-manager');
const fs = require('fs');
const path = require('path');

const GetWood = require('./tasks/GetWood');
const CraftTask = require('./tasks/CraftTask');
const MineBlock = require('./tasks/MineBlock');
const SmeltTask = require('./tasks/SmeltTask');
const MoveToSurface = require('./tasks/MoveToSurface');
const FightMob = require('./tasks/FightMob');
const BuildNetherPortal = require('./tasks/BuildNetherPortal');
const DigDown = require('./tasks/DigDown');
const { getInstance: getWoodBrain, WOOD_ACTIONS, encodeWoodState } = require('./lib/WoodBrain');

const DATASET_PATH = path.join(__dirname, '../data/dataset.json');

// ==================== ENCODAGE DE L'ÉTAT ====================
// Doit rester identique entre Recorder et LocalBrain !

const ACTIONS = [
    'GetWood',
    'CraftPlanks',
    'CraftCraftingTable',
    'CraftStick',
    'CraftWoodenPickaxe',
    'MineStone',
    'CraftStonePickaxe',
    'CraftStoneSword',
    'MineIronOre',
    'CraftFurnace',
    'SmeltIron',
    'CraftIronPickaxe',
    'CraftIronSword',
    'MineCoal',
    'DigDown',
    'MineObsidian',
    'MineGravel',
    'CraftFlintAndSteel',
    'BuildNetherPortal',
    'FightBlaze',
    'FightEnderman',
    'CraftBlazePowder',
    'CraftEyeOfEnder',
    'FindStronghold',
    'FightDragon',
    'MoveToSurface',
];

function encodeState(bot) {
    const inv = bot.inventory.items();
    const pos = bot.entity.position;

    const count = (name) => inv
        .filter(i => i.name.includes(name))
        .reduce((a, b) => a + b.count, 0);
    const has = (name) => count(name) > 0 ? 1 : 0;

    return [
        // Santé / Nourriture (normalisé 0-1)
        bot.health / 20,
        bot.food / 20,

        // Position Y normalisée (-64 → 0, 320 → 1)
        (pos.y + 64) / 384,

        // Outils (0 ou 1)
        has('wooden_pickaxe'),
        has('stone_pickaxe'),
        has('iron_pickaxe'),
        has('diamond_pickaxe'),
        has('wooden_sword'),
        has('stone_sword'),
        has('iron_sword'),
        has('diamond_sword'),

        // Ressources (normalisées, cap pour éviter les valeurs extrêmes)
        Math.min(count('log'), 64) / 64,
        Math.min(count('planks'), 64) / 64,
        Math.min(count('stick'), 32) / 32,
        Math.min(count('cobblestone') + count('cobbled_deepslate') + count('blackstone'), 64) / 64,
        Math.min(count('raw_iron'), 32) / 32,
        Math.min(count('iron_ingot'), 32) / 32,
        Math.min(count('coal') + count('charcoal'), 32) / 32,
        Math.min(count('diamond'), 16) / 16,
        Math.min(count('obsidian'), 16) / 16,
        Math.min(count('blaze_rod'), 12) / 12,
        Math.min(count('ender_pearl'), 16) / 16,
        Math.min(count('ender_eye'), 16) / 16,
        Math.min(count('gravel'), 16) / 16,
        Math.min(count('flint'), 4) / 4,

        // Items spéciaux
        has('crafting_table'),
        has('furnace'),
        has('flint_and_steel'),

        // Seuils importants pour la progression
        count('log') >= 3 ? 1 : 0,
        count('cobblestone') + count('cobbled_deepslate') >= 3 ? 1 : 0,
        count('cobblestone') + count('cobbled_deepslate') >= 8 ? 1 : 0,
        count('raw_iron') >= 6 ? 1 : 0,
        count('iron_ingot') >= 3 ? 1 : 0,
        count('iron_ingot') >= 6 ? 1 : 0,
        count('diamond') >= 3 ? 1 : 0,
        count('obsidian') >= 10 ? 1 : 0,
        count('blaze_rod') >= 6 ? 1 : 0,
        count('ender_pearl') >= 12 ? 1 : 0,

        // Position relative (sous terre ?)
        pos.y < 60 ? 1 : 0,
        pos.y < 16 ? 1 : 0,
    ];
}

function encodeAction(actionName) {
    const vec = new Array(ACTIONS.length).fill(0);
    const idx = ACTIONS.indexOf(actionName);
    if (idx !== -1) vec[idx] = 1;
    return vec;
}

function decodeAction(outputVec) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    outputVec.forEach((v, i) => { if (v > maxVal) { maxVal = v; maxIdx = i; } });
    return ACTIONS[maxIdx];
}

function describeState(bot) {
    const inv = bot.inventory.items();
    const count = (name) => inv.filter(i => i.name.includes(name)).reduce((a, b) => a + b.count, 0);
    const has = (name) => count(name) > 0;

    return [
        `Y:${bot.entity.position.y.toFixed(0)}`,
        `HP:${bot.health}/20`,
        `Food:${bot.food}/20`,
        has('diamond_pickaxe') ? 'DiamondPick' : has('iron_pickaxe') ? 'IronPick' : has('stone_pickaxe') ? 'StonePick' : has('wooden_pickaxe') ? 'WoodPick' : 'NoPick',
        has('iron_sword') ? 'IronSword' : has('stone_sword') ? 'StoneSword' : has('wooden_sword') ? 'WoodSword' : 'NoSword',
        `logs:${count('log')}`,
        `planks:${count('planks')}`,
        `cob:${count('cobblestone') + count('cobbled_deepslate')}`,
        `raw_iron:${count('raw_iron')}`,
        `iron_ingot:${count('iron_ingot')}`,
        `coal:${count('coal') + count('charcoal')}`,
        `diamond:${count('diamond')}`,
        `obsidian:${count('obsidian')}`,
        `blaze_rod:${count('blaze_rod')}`,
        `ender_pearl:${count('ender_pearl')}`,
        has('furnace') ? 'hasFurnace' : '',
        has('crafting_table') ? 'hasTable' : '',
        has('flint_and_steel') ? 'hasFlint' : '',
    ].filter(Boolean).join(' | ');
}

// ==================== RECORDER BOT ====================

function startRecorder(host, port) {
    let dataset = [];
    if (fs.existsSync(DATASET_PATH)) {
        try {
            dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
            console.log(`[Recorder] Dataset chargé : ${dataset.length} exemples`);
        } catch (e) {
            console.log('[Recorder] Nouveau dataset.');
        }
    }

    let currentTask = null;
    let isExecuting = false;

    const bot = mineflayer.createBot({
        host, port,
        username: 'RecorderBot',
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
        await bot.waitForChunksToLoad();
        const { configurePathfinder } = require('./lib/Survival');
        configurePathfinder(bot);

        console.log('[Recorder] Prêt ! Tape !do <action> dans le chat Minecraft.');
        console.log('[Recorder] Actions disponibles :', ACTIONS.join(', '));
        bot.chat('RecorderBot pret. Tape !do <action> pour m\'apprendre.');
        printState();
    });

    function printState() {
        const desc = describeState(bot);
        console.log(`\n[STATE] ${desc}`);
        console.log(`[Recorder] ${dataset.length} exemples dans le dataset.`);
        console.log(`[Recorder] Quelle action ? (!do <action> [args])`);
    }

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        const parts = message.trim().split(' ');
        const cmd = parts[0].toLowerCase();

        if (cmd === '!status') {
            printState();
            bot.chat(describeState(bot));
            return;
        }

        if (cmd === '!undo') {
            if (dataset.length > 0) {
                const removed = dataset.pop();
                saveDataset();
                bot.chat(`Dernier exemple supprime (${removed.action}). Total: ${dataset.length}`);
            } else {
                bot.chat('Dataset vide, rien a supprimer.');
            }
            return;
        }

        if (cmd === '!save') {
            saveDataset();
            bot.chat(`Dataset sauvegarde : ${dataset.length} exemples.`);
            return;
        }

        if (cmd === '!actions') {
            bot.chat('Actions: ' + ACTIONS.slice(0, 10).join(', ') + '...');
            return;
        }

        // ── Commandes WoodBrain ──────────────────────────────────────────────
        if (cmd === '!woodstatus') {
            const tempTask = new GetWood(bot, 99);
            const allLogs  = tempTask._findAllNearbyLogs();
            if (allLogs.length === 0) {
                bot.chat('Aucun arbre nearby.');
                return;
            }
            const info = tempTask._analyzeTree(allLogs);
            const { WoodBrain: WB } = require('./lib/WoodBrain');
            const rule = require('./lib/WoodBrain').ruleDecide(info);
            const brain = getWoodBrain();
            bot.chat(`Wood | botYInTree:${info.botYInTree.toFixed(2)} logsAbove:${info.logsAbove} logsBelow:${info.logsBelow} reachBelow:${info.hasLogWithinReachBelow} | Regle:${rule} | Dataset:${brain.dataset.length}`);
            console.log(`[WoodBrain] treeBase:${info.treeBaseY} treeTop:${info.treeTopY} distToBase:${info.distToLowestLog.toFixed(1)}`);
            return;
        }

        if (cmd === '!wood') {
            const MANUAL_WOOD_ACTIONS = ['MINE_BELOW', 'MINE_BASE', 'MINE_NEAREST'];
            const actionArg = (parts[1] || '').toUpperCase();
            if (!actionArg || !MANUAL_WOOD_ACTIONS.includes(actionArg)) {
                bot.chat(`Usage: !wood <action> | Actions: ${MANUAL_WOOD_ACTIONS.join(', ')}`);
                return;
            }
            if (isExecuting) {
                bot.chat('Deja en execution, attends...');
                return;
            }

            const tempTask = new GetWood(bot, 99);
            const allLogs  = tempTask._findAllNearbyLogs();
            if (allLogs.length === 0) {
                bot.chat('Aucun arbre nearby, impossible d\'enregistrer.');
                return;
            }

            const treeInfo   = tempTask._analyzeTree(allLogs);
            const brain      = getWoodBrain();
            const logsBefore = tempTask.countLogs();

            // Exécuter l'action d'abord
            isExecuting = true;
            try {
                switch (actionArg) {
                    case 'MINE_BELOW':   await tempTask._mineBelow(treeInfo);           break;
                    case 'MINE_BASE':    await tempTask._mineBase(treeInfo);            break;
                    case 'MINE_NEAREST': await tempTask._mineNearest(treeInfo.allLogs); break;
                }
                // Enregistrer seulement si des logs ont été collectés
                if (tempTask.countLogs() > logsBefore) {
                    brain.recordSuccess(bot, treeInfo, actionArg);
                    brain.saveAll();
                    bot.chat(`Succès ! Enregistré ${actionArg} (total: ${brain.dataset.length} ex)`);
                } else {
                    bot.chat(`${actionArg} échoué — non enregistré.`);
                }
            } catch (e) {
                bot.chat(`Erreur ${actionArg}: ${e.message}`);
            }
            isExecuting = false;
            printState();
            return;
        }
        // ── Commandes MovementBrain (DigDown) ────────────────────────────────
        if (cmd === '!digstatus') {
            const { getInstance: getMovBrain, encodeDigDownState, DIGDOWN_ACTIONS } = require('./lib/MovementBrain');
            const Vec3 = require('vec3').Vec3;
            const pos     = bot.entity.position;
            const yaw     = bot.entity.yaw;
            const cardinal = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
            const dx      = -Math.sin(cardinal);
            const dz      = -Math.cos(cardinal);
            const forward = new Vec3(Math.round(dx), 0, Math.round(dz));
            const botPos  = pos.floored();
            const head    = bot.blockAt(botPos.offset(forward.x, 1,  forward.z));
            const body    = bot.blockAt(botPos.offset(forward.x, 0,  forward.z));
            const floor   = bot.blockAt(botPos.offset(forward.x, -1, forward.z));
            const brain   = getMovBrain();
            bot.chat(`Dig | Y:${pos.y.toFixed(1)} dir:${(cardinal*180/Math.PI).toFixed(0)}° | front: head=${head?.name} body=${body?.name} floor=${floor?.name} | Dataset:${brain.digDataset.length}`);
            return;
        }

        if (cmd === '!dig') {
            const DIG_ACTIONS = ['DIG_HEAD', 'DIG_BODY', 'DIG_FLOOR', 'DIG_UNDER', 'MOVE_FORWARD', 'TURN'];
            const actionArg = (parts[1] || '').toUpperCase();
            if (!actionArg || !DIG_ACTIONS.includes(actionArg)) {
                bot.chat(`Usage: !dig <action> | Actions: ${DIG_ACTIONS.join(', ')}`);
                return;
            }
            if (isExecuting) { bot.chat('Deja en execution, attends...'); return; }

            const { getInstance: getMovBrain, encodeDigDownState, DIGDOWN_ACTIONS } = require('./lib/MovementBrain');
            const Vec3     = require('vec3').Vec3;
            const mcData   = require('minecraft-data')(bot.version);
            const pos      = bot.entity.position;
            const yaw      = bot.entity.yaw;
            const cardinal = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
            const dx       = -Math.sin(cardinal);
            const dz       = -Math.cos(cardinal);
            const forward  = new Vec3(Math.round(dx), 0, Math.round(dz));
            const botPos   = pos.floored();
            const yBefore  = pos.y;
            const targetY  = -54;

            isExecuting = true;
            try {
                // Équiper la pioche
                const pickaxe = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                if (pickaxe) await bot.equip(pickaxe, 'hand');

                await bot.look(cardinal, 0, true);

                if (actionArg === 'DIG_HEAD') {
                    const blk = bot.blockAt(botPos.offset(forward.x, 1, forward.z));
                    if (blk && blk.boundingBox === 'block') await bot.dig(blk);
                    else { bot.chat('Pas de bloc en face (tête).'); isExecuting = false; return; }

                } else if (actionArg === 'DIG_BODY') {
                    const blk = bot.blockAt(botPos.offset(forward.x, 0, forward.z));
                    if (blk && blk.boundingBox === 'block') await bot.dig(blk);
                    else { bot.chat('Pas de bloc en face (corps).'); isExecuting = false; return; }

                } else if (actionArg === 'DIG_FLOOR') {
                    const blk = bot.blockAt(botPos.offset(forward.x, -1, forward.z));
                    if (blk && blk.boundingBox === 'block') await bot.dig(blk);
                    else { bot.chat('Pas de bloc en face (sol).'); isExecuting = false; return; }

                } else if (actionArg === 'DIG_UNDER') {
                    const blk = bot.blockAt(botPos.offset(0, -1, 0));
                    if (blk && blk.boundingBox === 'block') await bot.dig(blk);
                    else { bot.chat('Pas de bloc sous les pieds.'); isExecuting = false; return; }

                } else if (actionArg === 'MOVE_FORWARD') {
                    const walkTarget = botPos.offset(forward.x, 0, forward.z).offset(0.5, 0, 0.5);
                    await bot.lookAt(walkTarget);
                    bot.setControlState('forward', true);
                    let s = 0;
                    while (bot.entity.position.distanceSquared(walkTarget) > 0.2 && s < 40) {
                        await bot.waitForTicks(1); s++;
                    }
                    bot.setControlState('forward', false);

                } else if (actionArg === 'TURN') {
                    const newYaw = cardinal - Math.PI / 2;
                    await bot.look(newYaw, 0, true);
                    await bot.waitForTicks(5);
                    bot.chat(`Tourné vers ${(newYaw * 180 / Math.PI).toFixed(0)}°`);
                    isExecuting = false;
                    return; // pas de récompense Y pour un tour
                }

                await bot.waitForTicks(5);
                const yAfter = bot.entity.position.y;

                // Enregistrer si le bot a descendu
                if (yAfter < yBefore - 0.3) {
                    const brain = getMovBrain();
                    brain.recordDigSuccess(bot, actionArg, targetY, forward, 0, yBefore);
                    brain.saveAll();
                    bot.chat(`Succès ! ${actionArg} enregistré (${yBefore.toFixed(1)}→${yAfter.toFixed(1)}) total:${brain.digDataset.length}`);
                } else {
                    bot.chat(`${actionArg} ok mais pas de descente — non enregistré. (Y:${yAfter.toFixed(1)})`);
                }
            } catch (e) {
                bot.chat(`Erreur !dig ${actionArg}: ${e.message}`);
            }
            isExecuting = false;
            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        if (cmd !== '!do') return;
        if (isExecuting) {
            bot.chat('Deja en train d\'executer une action, attends...');
            return;
        }

        const actionName = parts[1];
        const arg1 = parts[2];
        const arg2 = parts[3];
        const arg3 = parts[4];

        if (!actionName || !ACTIONS.includes(actionName)) {
            bot.chat(`Action inconnue: ${actionName}. Tape !actions pour la liste.`);
            return;
        }

        // Enregistrer l'état AVANT l'action
        const stateVector = encodeState(bot);
        const actionVector = encodeAction(actionName);

        console.log(`\n[Recorder] Enregistrement: ${actionName}`);
        console.log(`[STATE] ${describeState(bot)}`);

        // Ajouter au dataset
        dataset.push({
            input: stateVector,
            output: actionVector,
            action: actionName,
            timestamp: Date.now()
        });

        saveDataset();
        bot.chat(`OK, j'apprends: ${actionName}. Dataset: ${dataset.length} exemples.`);

        // Exécuter l'action
        isExecuting = true;
        currentTask = buildTask(bot, actionName, arg1, arg2, arg3);

        if (!currentTask) {
            bot.chat(`Impossible de creer la tache ${actionName}.`);
            isExecuting = false;
            return;
        }

        bot.chat(`Execution de ${actionName}...`);

        try {
            while (!currentTask.isDone()) {
                await currentTask.run();
                try { await bot.waitForTicks(5); } catch(e) { break; }
            }
            if (currentTask.hasFailed) {
                bot.chat(`${actionName} a echoue. L'exemple est quand meme garde.`);
            } else {
                bot.chat(`${actionName} termine !`);
            }
        } catch (err) {
            bot.chat(`Erreur pendant ${actionName}: ${err.message}`);
        }

        isExecuting = false;
        try { await bot.waitForTicks(10); } catch(e) {}
        printState();
    });

    function buildTask(bot, actionName, arg1, arg2, arg3) {
        try {
            switch (actionName) {
                case 'GetWood':           return new GetWood(bot, parseInt(arg1) || 3);
                case 'CraftPlanks':       return new CraftTask(bot, arg1 || 'oak_planks', parseInt(arg2) || 8);
                case 'CraftCraftingTable':return new CraftTask(bot, 'crafting_table', 1);
                case 'CraftStick':        return new CraftTask(bot, 'stick', parseInt(arg1) || 4);
                case 'CraftWoodenPickaxe':return new CraftTask(bot, 'wooden_pickaxe', 1);
                case 'MineStone':         return new MineBlock(bot, 'stone', parseInt(arg1) || 3);
                case 'CraftStonePickaxe': return new CraftTask(bot, 'stone_pickaxe', 1);
                case 'CraftStoneSword':   return new CraftTask(bot, 'stone_sword', 1);
                case 'MineIronOre':       return new MineBlock(bot, 'iron_ore', parseInt(arg1) || 6);
                case 'CraftFurnace':      return new CraftTask(bot, 'furnace', 1);
                case 'SmeltIron':         return new SmeltTask(bot, 'raw_iron', 'iron_ingot', parseInt(arg1) || 6);
                case 'CraftIronPickaxe':  return new CraftTask(bot, 'iron_pickaxe', 1);
                case 'CraftIronSword':    return new CraftTask(bot, 'iron_sword', 1);
                case 'MineCoal':          return new MineBlock(bot, 'coal_ore', parseInt(arg1) || 3);
                case 'DigDown':           return new DigDown(bot, parseInt(arg1) || -54);
                case 'MineObsidian':      return new MineBlock(bot, 'obsidian', parseInt(arg1) || 10);
                case 'MineGravel':        return new MineBlock(bot, 'gravel', parseInt(arg1) || 5);
                case 'CraftFlintAndSteel':return new CraftTask(bot, 'flint_and_steel', 1);
                case 'BuildNetherPortal': return new BuildNetherPortal(bot);
                case 'FightBlaze':        return new FightMob(bot, 'blaze', parseInt(arg1) || 6);
                case 'FightEnderman':     return new FightMob(bot, 'enderman', parseInt(arg1) || 12);
                case 'CraftBlazePowder':  return new CraftTask(bot, 'blaze_powder', parseInt(arg1) || 6);
                case 'CraftEyeOfEnder':   return new CraftTask(bot, 'ender_eye', parseInt(arg1) || 12);
                case 'MoveToSurface':     return new MoveToSurface(bot);
                default:
                    console.log(`[Recorder] Action non implémentée : ${actionName}`);
                    return null;
            }
        } catch (e) {
            console.log(`[Recorder] Erreur création tâche: ${e.message}`);
            return null;
        }
    }

    function saveDataset() {
        const tmp = DATASET_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(dataset, null, 2));
        fs.renameSync(tmp, DATASET_PATH);
    }

    bot.on('kicked', (reason) => {
        console.log('[Recorder] Kicked:', reason);
        saveDataset();
    });
    bot.on('error', console.error);

    return bot;
}

module.exports = { startRecorder, encodeState, encodeAction, decodeAction, ACTIONS };
