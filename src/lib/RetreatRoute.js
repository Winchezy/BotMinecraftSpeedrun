const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { existingPassageMovements, planCompletePath } = require('./Pathing');

async function findRetreatRoute(bot,enemies) {
    const revision = bot.threatRevision || 0;
    const origin=bot.entity.position.floored();
    const clearance=point=>Math.min(...enemies.map(enemy=>point.distanceTo(enemy.position)));
    const initial=clearance(origin);
    const queue=[origin];
    const seen=new Set([origin.toString()]);
    const candidates=[];
    const hazard=/water|lava|fire|magma|cactus|powder_snow|campfire/;
    const standable=p=>{
        const floor=bot.blockAt(p.offset(0,-1,0)), feet=bot.blockAt(p), head=bot.blockAt(p.offset(0,1,0));
        return floor?.boundingBox==='block' && feet?.boundingBox==='empty' && head?.boundingBox==='empty' &&
            !hazard.test(floor.name+feet.name+head.name);
    };
    for (let index=0;index<queue.length && index<512;index++) {
        const point=queue[index];
        for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const y of [0,1,-1]) {
            const next=point.offset(x,y,z);
            if (seen.has(next.toString()) || Math.hypot(next.x-origin.x,next.z-origin.z)>10 ||
                Math.abs(next.y-origin.y)>8 || !standable(next) || clearance(next)<initial-0.25) continue;
            if (y===1 && bot.blockAt(point.offset(0,2,0))?.boundingBox!=='empty') continue;
            seen.add(next.toString());queue.push(next);
            if (clearance(next)>initial+2) candidates.push(next);
        }
    }
    candidates.sort((a,b)=>(clearance(b)-b.distanceTo(origin)*0.1)-(clearance(a)-a.distanceTo(origin)*0.1));
    const movements=existingPassageMovements(bot);
    for (const target of candidates.slice(0,8)) {
        if ((bot.threatRevision || 0) !== revision) return null;
        const goal=new goals.GoalBlock(target.x,target.y,target.z);
        const result=await planCompletePath(bot,goal,500,movements, {
            allowCombat: true, shouldInterrupt: () => (bot.threatRevision || 0) !== revision
        });
        if (result.status!=='success' || !result.path?.length) continue;
        let previous=origin;
        if (result.path.some(step=>{
            const bad=previous.y-step.y>1 || step.parkour || step.toPlace?.length || step.toBreak?.length || clearance(step)<initial-0.25;
            previous=step;return bad;
        })) continue;
        return {goal,movements,target};
    }
    return null;
}

module.exports={findRetreatRoute};
