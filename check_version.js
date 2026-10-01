const mcData = require('minecraft-data');
console.log('Installed minecraft-data version:', require('minecraft-data/package.json').version);
console.log('PC Versions supported:', mcData.versions.pc.map(v => v.minecraftVersion).join(', '));
try {
    const v = mcData('1.21.1');
    console.log('1.21.1 data found:', !!v);
} catch (e) {
    console.log('1.21.1 data NOT found');
}
