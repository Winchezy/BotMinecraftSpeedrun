const fs=require('fs'),path=require('path');
const {Vec3}=require('vec3');
const {goals}=require('mineflayer-pathfinder');
const {existingPassageMovements,planCompletePath,withTimeout}=require('./Pathing');
const {threatNearPoint,threatNearPath}=require('./MobSafety');
const {safeExplorationPath}=require('./ExplorationSafety');
class Workstations {
    constructor(bot) {
        this.bot=bot;this.locations={};this.failed=new Map();
        if(bot.username) {
            this.filename=path.join(__dirname,'../../.bot-state',`workstations-${bot.username.replace(/[^a-z0-9_-]/gi,'_')}.json`);
            try{this.locations=JSON.parse(fs.readFileSync(this.filename,'utf8'));}catch(_){}
        }
    }
    key(name){return `${this.bot._client?.socket?.remoteAddress}:${this.bot._client?.socket?.remotePort}:${this.bot.game?.dimension||'overworld'}:${name}`;}
    save(){if(!this.filename)return;try{fs.mkdirSync(path.dirname(this.filename),{recursive:true});fs.writeFileSync(this.filename+'.tmp',JSON.stringify(this.locations));fs.renameSync(this.filename+'.tmp',this.filename);}catch(error){console.log(`[Workstations] ${error.message}`);}}
    remember(name,p){this.locations[this.key(name)]={x:p.x,y:p.y,z:p.z};this.failed.delete(this.key(name));this.save();}
    async recover(name){
        const bot=this.bot,key=this.key(name),saved=this.locations[key];
        if(!saved || (this.failed.get(key)||0)>Date.now() || bot.isInCombat?.() || bot.inventory.items().some(i=>i.name===name))return false;
        const p=new Vec3(saved.x,saved.y,saved.z);
        if(p.distanceTo(bot.entity.position)>32 || threatNearPoint(bot,p,4) || threatNearPoint(bot,bot.entity.position,4))return false;
        const block=bot.blockAt(p);
        if(!block)return false;
        if(block.name!==name){delete this.locations[key];this.save();return false;}
        const pick=bot.inventory.items().find(i=>i.name.endsWith('_pickaxe'));
        if((name==='furnace' && !pick) || bot.inventory.emptySlotCount?.()===0 || p.equals(bot.entity.position.floored().offset(0,-1,0)))return false;
        for(const [x,y,z] of [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]){
            const b=bot.blockAt(p.offset(x,y,z));if(!b || /water|lava|sand|gravel/.test(b.name))return false;
        }
        const original=bot.pathfinder.movements,walking=existingPassageMovements(bot);
        const goal=new goals.GoalLookAtBlock(p,bot.world,{reach:3});
        const route=await planCompletePath(bot,goal,800,walking);
        if(route.status!=='success' || (route.path?.length && !safeExplorationPath(bot,route.path)) || threatNearPath(bot,route.path))return false;
        const count=()=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0),before=count();
        try{
            bot.pathfinder.setMovements(walking);
            await withTimeout(bot,bot.pathfinder.goto(goal),10000,'Ancien atelier inaccessible');
            if(bot.isInCombat?.() || threatNearPoint(bot,p,4) || !bot.canDigBlock(bot.blockAt(p)))return false;
            // Verifier avant de casser que le ramassage est lui aussi accessible.
            const pickup=new goals.GoalNear(p.x,p.y,p.z,1);
            const collect=await planCompletePath(bot,pickup,600,walking);
            if(collect.status!=='success' || threatNearPath(bot,collect.path))return false;
            if(name==='furnace'){
                const window=await withTimeout(bot,bot.openFurnace(bot.blockAt(p)),5000,'Ouverture du four bloquee');
                try{
                    if(window.outputItem())await window.takeOutput();
                    if(window.inputItem())await window.takeInput();
                    if(window.fuelItem())await window.takeFuel();
                    if(window.outputItem() || window.inputItem() || window.fuelItem())return false;
                }finally{window.close();}
                await bot.equip(pick,'hand');
            }
            if(bot.isInCombat?.() || threatNearPoint(bot,p,4))return false;
            await withTimeout(bot,bot.dig(bot.blockAt(p)),7000,'Recuperation de l atelier bloquee');
            await withTimeout(bot,bot.pathfinder.goto(pickup),5000,'Ramassage bloque');await bot.waitForTicks(10);
            if(count()<=before)return false;
            delete this.locations[key];this.save();
            bot.chat?.(`[SpeedBot] ${name==='furnace'?'Dernier four':'Derniere table'} recupere pour reutilisation.`);return true;
        }catch(error){this.failed.set(key,Date.now()+60000);console.log(`[Workstations] ${error.message}`);return false;}
        finally{bot.pathfinder.setMovements(original);bot.clearControlStates?.();}
    }
}
module.exports=bot=>bot.workstations ||= new Workstations(bot);
