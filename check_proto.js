const mcData = require('minecraft-data');
const pcVersions = mcData.versions.pc;
const v774 = pcVersions.find(v => v.version === 774);
console.log('Version with protocol 774:', v774);

const v121_1 = pcVersions.find(v => v.minecraftVersion === '1.21.1');
console.log('1.21.1 protocol:', v121_1);
