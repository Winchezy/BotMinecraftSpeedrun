const { Vec3 } = require('vec3');

const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|berry_bush/;

function safeExplorationStep(bot, step) {
    const point = new Vec3(Math.floor(step.x),Math.floor(step.y),Math.floor(step.z));
    const floor = bot.blockAt(point.offset(0,-1,0));
    if (!floor || floor.boundingBox !== 'block' || HAZARD.test(floor.name) ||
        step.parkour || step.toPlace?.length) return false;
    // Une marge laterale evite qu'une petite deviation finisse dans un ravin.
    for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const side = point.offset(x,0,z);
        const wall = bot.blockAt(side);
        if (wall?.boundingBox === 'block' && !HAZARD.test(wall.name)) continue;
        let supported = false;
        for (let depth=1;depth<=2;depth++) {
            const block = bot.blockAt(side.offset(0,-depth,0));
            if (!block || HAZARD.test(block.name)) return false;
            if (block.boundingBox === 'block') {supported=true;break;}
        }
        if (!supported) return false;
    }
    return true;
}

function safeExplorationPath(bot,path) {
    return !!path?.length && path.every(step=>safeExplorationStep(bot,step));
}

function safeExplorationProbe(bot, point, path) {
    if (safeExplorationStep(bot, point)) return true;
    // Pendant une descente, la sonde horizontale conserve l'altitude actuelle :
    // son sol parait absent alors que le prochain noeud est un bloc plus bas.
    // N'accepter que ce noeud effectivement planifie et toujours sur terrain sur.
    const lower = path?.find(step => Math.floor(step.x) === point.x &&
        Math.floor(step.z) === point.z && Math.floor(step.y) === point.y - 1);
    return !!lower && safeExplorationStep(bot, lower);
}

function safeExplorationBreak(bot,block) {
    if (!block?.position || !/^(dirt|coarse_dirt|grass_block)$|_leaves$/.test(block.name)) return false;
    const feet=bot.entity.position.floored();
    if (block.position.y<feet.y || bot.isInCombat?.()) return false;
    const {threatNearPoint}=require('./MobSafety');
    if (threatNearPoint(bot,block.position,2)) return false;
    for (const [x,y,z] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) {
        const neighbor=bot.blockAt(block.position.offset(x,y,z));
        if (!neighbor || /water|lava|sand|gravel/.test(neighbor.name)) return false;
    }
    return true;
}

async function supportExplorationEdge(bot, step) {
    if (!step || step.parkour || step.toPlace?.length || bot.isInCombat?.()) return false;
    const point = new Vec3(Math.floor(step.x), Math.floor(step.y), Math.floor(step.z));
    const ownFloor = bot.blockAt(point.offset(0,-1,0));
    if (ownFloor?.boundingBox !== 'block' || HAZARD.test(ownFloor.name) ||
        bot.blockAt(point.offset(0,-2,0))?.boundingBox !== 'block') return false;
    const { threatNearPoint } = require('./MobSafety');
    if (threatNearPoint(bot,bot.entity.position,2) || threatNearPoint(bot,point,2)) return false;
    const material = bot.inventory.items().find(i => ['cobblestone','dirt','coarse_dirt'].includes(i.name));
    if (!material) return false;
    const feet = bot.entity.position.floored();
    const eye = bot.entity.position.offset(0,1.62,0);
    for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const side = point.offset(x,0,z);
        if (bot.blockAt(side)?.boundingBox === 'block') continue;
        if ([1,2].some(depth => bot.blockAt(side.offset(0,-depth,0))?.boundingBox === 'block')) continue;
        const target = side.offset(0,-1,0);
        if (bot.blockAt(target)?.name !== 'air' || eye.distanceTo(target.offset(0.5,0.5,0.5)) > 4 ||
            target.x === feet.x && target.z === feet.z && target.y >= feet.y - 1) continue;
        const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        const neighbors = offsets.map(([a,b,c]) => bot.blockAt(target.offset(a,b,c)));
        if (neighbors.some(block => !block || HAZARD.test(block.name) || /sand|gravel/.test(block.name))) continue;
        const reference = neighbors.find(block => block.boundingBox === 'block' && block.position);
        if (!reference) continue;
        try {
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            await bot.equip(material,'hand');
            await require('./Pathing').withTimeout(bot,bot.placeBlock(reference,target.minus(reference.position)),3000,'Appui lateral');
            if (bot.blockAt(target)?.boundingBox !== 'block') return false;
            console.log(`[GetFood] Appui lateral pose et verifie en ${target}; nouveau calcul du trajet.`);
            return true;
        } catch (error) {
            if (error.code === 'ACTION_INTERRUPTED') throw error;
            console.log(`[GetFood] Appui lateral impossible : ${error.message}`);
            return false;
        }
    }
    return false;
}

module.exports = {safeExplorationStep,safeExplorationPath,safeExplorationProbe,safeExplorationBreak,supportExplorationEdge};
