const fs = require('fs');
const path = require('path');
const source = path.resolve(__dirname, '../../altoclef');
const files = [
  'LICENSE', 'build.gradle', 'settings.gradle.kts', 'gradle.properties', 'local-tests/LocalSafetyPolicyTest.java', 'local-tests/WitherDefensePolicyTest.java',
  ...[
    'tasks/resources/CollectBlazeRodsTask.java', 'tasks/resources/KillEndermanTask.java',
    'tasks/resources/CollectBucketLiquidTask.java',
    'tasks/entity/AbstractDoToEntityTask.java', 'tasks/movement/PickupDroppedItemTask.java',
    'tasks/slot/EnsureFreeInventorySlotTask.java',
    'tasks/entity/WitherSkeletonDefenseTask.java', 'chains/MobDefenseChain.java', 'util/helpers/WitherDefensePolicy.java',
    'control/KillAura.java', 'util/helpers/StorageHelper.java', 'util/helpers/ItemHelper.java',
    'util/helpers/LocalSafetyPolicy.java', 'util/helpers/CombatGroundHelper.java',
    'util/helpers/InventoryCapacityPolicy.java', 'trackers/storage/InventorySubTracker.java'
  ].map(name => 'src/main/java/adris/altoclef/' + name)
];
for (const file of files) {
  const destination = path.join(__dirname, 'overlay', file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(source, file), destination);
}
console.log(`${files.length} fichiers sauvegardés dans tools/altoclef-local/overlay`);
