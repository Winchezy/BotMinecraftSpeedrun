const fs=require('fs');
const crypto=require('crypto');
const nbt=require('prismarine-nbt');
const bytes=crypto.createHash('md5').update('OfflinePlayer:SpeedBot').digest();
bytes[6]=(bytes[6]&15)|48;bytes[8]=(bytes[8]&63)|128;
const hex=bytes.toString('hex');
const uuid=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
nbt.parse(fs.readFileSync(`server/world/playerdata/${uuid}.dat`)).then(({parsed})=>{
const data=nbt.simplify(parsed);
console.log(JSON.stringify({uuid,position:data.Pos,inventory:data.Inventory?.map(i=>({name:i.id,count:i.Count})),lastDeath:data.LastDeathLocation},null,2));
if (process.argv.includes('--restore')) {
    const death=data.LastDeathLocation;
    if (!death || death.dimension !== 'minecraft:overworld' || !death.pos.every(Number.isFinite)) throw new Error('Position invalide');
    fs.mkdirSync('.bot-state',{recursive:true});
    fs.writeFileSync('.bot-state/death-SpeedBot.json',JSON.stringify({position:{x:death.pos[0],y:death.pos[1],z:death.pos[2]},
        dimension:'overworld',server:'127.0.0.1:25565',time:Date.now()}));
}
});
