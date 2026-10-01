// Survival utilities for the bot

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

// Last safe position tracking (Module Scope)
let lastSafePosition = null;
let lastSafePositionTime = Date.now();

// Cerveau de survie neuronal (initialisé dans setupSurvival)
let survivalBrain = null;
try {
    const { getInstance } = require('./SurvivalBrain');
    survivalBrain = getInstance();
} catch (e) {
    console.log('[Survival] SurvivalBrain non disponible:', e.message);
}

// Protected blocks (water blockers) that should NEVER be mined
const protectedBlocks = new Set(); // Store as "x,y,z" strings

function setupSurvival(bot) {
    const mcData = require('minecraft-data')(bot.version);
    // Remove local declarations


    // Auto respawn on death
    bot.on('death', () => {
        console.log('[Survival] Bot died! Respawning...');
        // Don't reset lastSafePosition - keep it as a fallback
        // The spawn point might be in water, so we want to be able to find land

        bot.once('spawn', async () => {
            console.log('[Survival] Respawned! Looking for safe ground...');

            // Wait a moment for the bot to stabilize
            await bot.waitForTicks(20);

            // Check if spawn is in water
            const pos = bot.entity.position;
            const feetBlock = bot.blockAt(pos.floored());

            if (feetBlock && feetBlock.name.includes('water')) {
                console.log('[Survival] Spawned in water! Swimming to safety...');
                // Start jumping immediately
                bot.setControlState('jump', true);
                bot.setControlState('forward', true);

                // Try to find nearby land
                const landBlock = bot.findBlock({
                    matching: (b) => b.name !== 'water' && b.name !== 'air' && b.boundingBox === 'block',
                    maxDistance: 20
                });

                if (landBlock) {
                    console.log(`[Survival] Found land at ${landBlock.position}!`);
                    lastSafePosition = landBlock.position.offset(0, 1, 0);
                }
            } else {
                // Spawn is safe, save it
                lastSafePosition = pos.clone();
                console.log('[Survival] Spawn is safe!');
            }
        });
    });

    let isEating = false;

    // Health monitoring with auto-eat
    bot.on('health', async () => {
        if (bot.health < 7 && !isEating) {
            console.log(`[Survival] Low health: ${bot.health}/20`);

            // Décision neuronale : manger ou non ?
            let shouldEat = true;
            if (survivalBrain) {
                const neuralDecision = survivalBrain.decide(bot, { recentDamage: true });
                if (neuralDecision) {
                    shouldEat = neuralDecision.action === 'EAT_FOOD' || neuralDecision.action === 'DO_NOTHING';
                    if (!shouldEat) {
                        console.log(`[SurvivalBrain] Santé faible mais décision: ${neuralDecision.action} → pas de repas`);
                    }
                }
                // Enregistrement pour l'entraînement (règle = manger si nourriture dispo)
            }

            // Try to eat food
            const food = bot.inventory.items().find(item =>
                item.name.includes('flesh') ||
                item.name.includes('beef') ||
                item.name.includes('pork') ||
                item.name.includes('bread') ||
                item.name.includes('apple') ||
                item.name.includes('carrot') ||
                item.name.includes('potato')
            );

            if (food && shouldEat) {
                const _healthBefore = bot.health;
                isEating = true;
                try {
                    console.log(`[Survival] EMERGENCY: Eating ${food.name}!`);
                    await bot.equip(food, 'hand');

                    if (bot.consume) {
                        await bot.consume();
                    } else {
                        bot.activateItem();
                        await bot.waitForTicks(35);
                        bot.deactivateItem();
                    }
                    // Enregistrer seulement si la santé a augmenté
                    if (survivalBrain && bot.health > _healthBefore) {
                        survivalBrain.recordSuccess(bot, 'EAT_FOOD', { recentDamage: true });
                    }
                } catch (e) {
                    console.log(`[Survival] Failed to eat: ${e.message}`);
                }
                isEating = false;
            }
        }
        if (bot.food < 5) {
            console.log(`[Survival] Hungry: ${bot.food}/20`);
        }
    });

    // Combat defense system - fight back when attacked
    const hostileMobs = [
        'zombie', 'skeleton', 'spider', 'creeper', 'enderman',
        'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
        'zombie_villager', 'pillager', 'vindicator', 'ravager',
        'blaze', 'ghast', 'magma_cube', 'hoglin', 'piglin_brute',
        'warden', 'wither_skeleton'
    ];

    let isInCombat = false;
    let combatTarget = null;
    let combatStartTime = null;

    // React to damage (e.g. being shot by skeleton)
    bot.on('entityHurt', (entity) => {
        if (entity !== bot.entity) return;

        // Ignorer si aucun hostile à proximité (ex: dégâts de chute)
        const hostileNames = ['zombie','skeleton','spider','creeper','enderman','witch',
            'slime','phantom','drowned','husk','stray','blaze','ghast','magma_cube',
            'hoglin','piglin_brute','warden','wither_skeleton'];
        const hasNearbyHostile = !!bot.nearestEntity(e => {
            if (!e || !e.name || e === bot.entity) return false;
            const dist = e.position?.distanceTo(bot.entity.position) ?? 99;
            return dist < 10 && hostileNames.some(h => e.name.toLowerCase().includes(h));
        });

        if (!hasNearbyHostile) return; // dégâts de chute ou autre cause non-hostile

        console.log('[Survival] Ouch! Took damage. Scanning for threats...');
        checkForThreats(true);
    });

    // Check for hostile mobs targeting the bot
    let lastThreatCheck = 0;
    const checkForThreats = async (urgent = false) => {
        // Throttle: max once per 3 seconds (unless urgent damage)
        const now = Date.now();
        if (!urgent && (now - lastThreatCheck) < 3000) return;
        lastThreatCheck = now;

        try {
            if (!bot.entity) return;

            // Scan for hostiles (debug logs removed)

            // Find nearby hostile mobs - FIXED: removed broken type check
            const nearbyHostile = bot.nearestEntity((entity) => {
                if (!entity || !entity.name || entity === bot.entity) return false;

                const isHostile = hostileMobs.some(h => entity.name.toLowerCase().includes(h));
                if (!isHostile) return false;

                const distance = bot.entity.position.distanceTo(entity.position);
                // React to any hostile within 16 blocks
                return distance < 16;
            });

            // Timeout de sécurité : reset combat après 12s sans résolution
            if (isInCombat && combatStartTime && Date.now() - combatStartTime > 12000) {
                console.log('[Survival] Combat timeout — reset forcé.');
                isInCombat    = false;
                combatTarget  = null;
                combatStartTime = null;
                try { bot.pvp.stop(); } catch (e) {}
            }

            if (nearbyHostile) {
                if (!isInCombat || combatTarget !== nearbyHostile) {
                    console.log(`[Survival] THREAT DETECTED: ${nearbyHostile.name} at distance ${bot.entity.position.distanceTo(nearbyHostile.position).toFixed(1)}`);
                }
                await handleThreat(bot, nearbyHostile, urgent);
            } else {
                if (isInCombat) {
                    if (!combatTarget || !combatTarget.isValid || bot.entity.position.distanceTo(combatTarget.position) > 16) {
                        isInCombat    = false;
                        combatTarget  = null;
                        combatStartTime = null;
                        bot.pvp.stop();
                        bot.pathfinder.stop();
                        // N'annoncer que si le bot est encore vivant (pas une mort/respawn)
                        if (bot.health > 0) {
                            console.log('[Survival] Combat threat cleared/lost. Resuming duties.');
                        }
                    } else {
                        try { bot.pvp.attack(combatTarget); } catch (e) { }
                    }
                }
            }
        } catch (e) {
            console.error("[Survival] Threat Check Error:", e);
        }
    };

    // Helper to keep code clean and fix nesting
    async function handleThreat(bot, nearbyHostile, urgent) {
        if (!isInCombat || combatTarget !== nearbyHostile) {
            const isRanged    = nearbyHostile.name.includes('skeleton') || nearbyHostile.name.includes('witch') || nearbyHostile.name.includes('blaze');
            const isExplosive = nearbyHostile.name.includes('creeper');
            const hasWeapon   = await equipBestWeapon(bot);
            let safeToFight   = true;

            // ── Décision neuronale ────────────────────────────────────────────
            if (survivalBrain) {
                const ctx = { recentDamage: urgent };
                const neuralDecision = survivalBrain.decide(bot, ctx);
                if (neuralDecision) {
                    const { action } = neuralDecision;
                    if (action === 'FIGHT') {
                        isInCombat    = true;
                        combatTarget  = nearbyHostile;
                        console.log(`[SurvivalBrain] COMBAT → ${nearbyHostile.name}`);
                        bot.pathfinder.stop();
                        bot.pvp.stop();
                        try { bot.pvp.attack(nearbyHostile); } catch (e) { bot.attack(nearbyHostile); }
                        return;
                    } else if (action === 'FLEE') {
                        console.log(`[SurvivalBrain] FUITE → ${nearbyHostile.name}`);
                        await retreat(bot, nearbyHostile);
                        return;
                    }
                    // DO_NOTHING ou autre → les règles prennent la relève
                }
            }
            // ─────────────────────────────────────────────────────────────────

            const nearbyEntities = Object.values(bot.entities).filter(e =>
                e.type === 'mob' &&
                hostileMobs.some(h => e.name?.includes(h)) &&
                e.position.distanceTo(bot.entity.position) < 10
            );

            // User Rule: Do not attack if health is < 1/3 max (20/3 = ~6.66)
            if (bot.health < 7) {
                safeToFight = false;
                console.log(`[Survival] Health CRITICAL (${bot.health}/20). Too low to fight. RETREATING.`);
            } else if (nearbyEntities.length >= 2) {
                safeToFight = false;
                console.log(`[Survival] GROUP DETECTED (${nearbyEntities.length} >= 2)! Overwhelmed. RETREATING.`);
            } else if (isExplosive) {
                // CRITICAL: If we're in water, IGNORE creeper and focus on blocking water first
                const pos = bot.entity.position;
                const feetBlock = bot.blockAt(pos.floored());
                const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());
                const inWater = (feetBlock && feetBlock.name.includes('water')) ||
                    (headBlock && headBlock.name.includes('water'));

                if (inWater) {
                    // In water - can't flee effectively. Let water blocking handle it.
                    console.log(`[Survival] Creeper detected but IN WATER. Prioritizing water escape over creeper.`);
                    return false; // Don't interrupt water escape
                }

                safeToFight = false;
                console.log(`[Survival] Creeper identified. EXPLOSIVE HAZARD. Retreating immediately.`);
            } else if (nearbyHostile.name.includes('zombie') && (nearbyHostile.height < 1.0 || (nearbyHostile.metadata && nearbyHostile.metadata[16]))) {
                safeToFight = false;
                console.log(`[Survival] Baby Zombie identified. SPEED HAZARD. Retreating immediately.`);
            } else if (isRanged && nearbyHostile.name.includes('skeleton')) {
                if (hasWeapon) {
                    if (bot.health < 4) {
                        safeToFight = false;
                        console.log(`[Survival] CRITICAL HEALTH (${bot.health}). Retreating from Skeleton.`);
                    } else {
                        safeToFight = true;
                        console.log(`[Survival] Have sword. Charging Skeleton!`);
                    }
                } else {
                    safeToFight = false;
                    console.log(`[Survival] Skeleton + No Sword -> FLEEING.`);
                }
            } else if (!hasWeapon && !isRanged) {
                console.log(`[Survival] Fighting ${nearbyHostile.name} bare-handed!`);
                safeToFight = true;
            }

            if (safeToFight) {
                isInCombat      = true;
                combatTarget    = nearbyHostile;
                combatStartTime = Date.now();
                const msg = `[Survival] Engaging ${nearbyHostile.name}`;
                console.log(msg);
                bot.chat(msg);
                bot.pathfinder.stop();
                bot.pvp.stop();

                // CRITICAL: Equip sword before attacking!
                const weapon = bot.inventory.items().find(i => i.name.includes('sword'));
                if (weapon) {
                    try {
                        await bot.equip(weapon, 'hand');
                        console.log(`[Survival] Equipped ${weapon.name} for combat`);
                    } catch (err) {
                        console.log(`[Survival] Failed to equip weapon: ${err.message}`);
                    }
                }

                const _healthBeforeFight = bot.health ?? 20;
                try {
                    bot.pvp.attack(nearbyHostile);
                } catch (e) {
                    // Fallback : naviguer vers la cible puis attaquer manuellement
                    console.log(`[Survival] pvp.attack échoué (${e.message}), fallback manuel.`);
                    const { goals } = require('mineflayer-pathfinder');
                    bot.pathfinder.setGoal(new goals.GoalFollow(nearbyHostile, 2), true);
                }
                // Enregistrement récompense : succès si la cible n'existe plus après 3s
                if (survivalBrain) {
                    const _fightTarget = nearbyHostile;
                    setTimeout(() => {
                        const stillAlive = bot.entities[_fightTarget.id];
                        if (!stillAlive) survivalBrain.recordSuccess(bot, 'FIGHT', { recentDamage: urgent });
                    }, 3000);
                }
            } else {
                if (isInCombat || urgent || nearbyHostile.position.distanceTo(bot.entity.position) < 15) {
                    console.log(`[Survival] Active Retreat from ${nearbyHostile.name}`);
                    const _healthBeforeFlee = bot.health ?? 20;
                    await retreat(bot, nearbyHostile);
                    // Enregistrement récompense : succès si santé préservée après fuite
                    if (survivalBrain && (bot.health ?? 20) >= _healthBeforeFlee) {
                        survivalBrain.recordSuccess(bot, 'FLEE', { recentDamage: urgent });
                    }
                }
            }
        } else {
            // Already in combat with this target. Refresh the attack state if needed,
            // occasionally bot gets stuck because pathfinder got interrupted.
            if (Date.now() % 2000 < 500) { // Refresh every ~2 seconds
               try { bot.pvp.attack(nearbyHostile); } catch(e) {}
            }
        }
    }

    async function retreat(bot, enemy) {
        // Calculate vector away from enemy
        const { goals } = require('mineflayer-pathfinder');
        const defaultMove = new goals.GoalInvert(new goals.GoalFollow(enemy, 5));

        // Simpler: Pick a spot 16 blocks away in opposite direction
        const escapeVec = bot.entity.position.minus(enemy.position).normalize().scaled(16);
        const escapePos = bot.entity.position.plus(escapeVec);

        bot.pathfinder.setGoal(new goals.GoalNear(escapePos.x, escapePos.y, escapePos.z, 2));
    }

    // Check threats periodically
    setInterval(() => checkForThreats(false), 500);

    // Expose combat state
    bot.isInCombat = () => isInCombat;

    // Safe position tracking - save position when NOT in water + check for falling blocks
    let safeCheckInterval = setInterval(() => {
        if (!bot.entity) return;

        const pos = bot.entity.position;
        const feetBlock = bot.blockAt(pos.floored());
        const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        // CRITICAL: Check for falling blocks (gravel/sand) above
        for (let y = 1; y <= 3; y++) {
            const blockAbove = bot.blockAt(pos.offset(0, y, 0).floored());
            if (blockAbove && (blockAbove.name === 'gravel' || blockAbove.name === 'sand')) {
                console.log(`[Survival] DANGER: ${blockAbove.name} detected ${y} blocks above! Moving away!`);
                // Move sideways immediately
                const escapeX = Math.random() > 0.5 ? 2 : -2;
                const escapeZ = Math.random() > 0.5 ? 2 : -2;
                bot.pathfinder.setGoal(null);
                bot.pathfinder.setGoal(new (require('mineflayer-pathfinder').goals.GoalBlock)(
                    Math.floor(pos.x + escapeX),
                    Math.floor(pos.y),
                    Math.floor(pos.z + escapeZ)
                ));
                break;
            }
        }

        // Only save as safe if NOT in water AND on solid ground above sea level
        if (!inWater && pos.y >= 60) {
            const blockBelow = bot.blockAt(pos.offset(0, -1, 0).floored());
            if (blockBelow && blockBelow.name !== 'air' && !blockBelow.name.includes('water')) {
                lastSafePosition = pos.clone();
                lastSafePositionTime = Date.now();
            }
        }
    }, 1000); // Check every second


    // Water escape system AND Stuck-On-Land Detection
    let lastWaterCheck = Date.now();
    let inWaterTicks = 0;
    let escapeAttempts = 0;
    let lastBlockPlacement = 0; // Cooldown for water blocking

    // Land stuck detection
    let lastPosition = null;
    let lastMoveTime = Date.now();
    let stuckOnLandTicks = 0;
    let survivalForcedJump = false; // ne relâcher jump que si c'est nous qui l'avons forcé


    bot.on('physicsTick', async () => {
        if (Date.now() - lastWaterCheck < 300) return;
        lastWaterCheck = Date.now();

        // Prevent interrupting ongoing actions
        if (bot.targetDigBlock || bot.pathfinder.isMining()) return;

        const pos = bot.entity.position;
        const feetBlock = bot.blockAt(pos.floored());
        const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        // 1. LAND STUCK DETECTION (If attempting to move but position not changing)
        // Ne pas interférer si le bot mine, collecte, interagit ou pose un bloc
        // (isBuilding: le pathfinder maintient jump pour poser un bloc sous ses pieds)
        const isBusy = bot.targetDigBlock || bot.isSleeping ||
            (typeof bot.pathfinder.isBuilding === 'function' && bot.pathfinder.isBuilding());
        if (bot.pathfinder.isMoving() && !inWater && !isBusy) {
            const currentPos = bot.entity.position;
            if (lastPosition) {
                const dist = currentPos.distanceTo(lastPosition);
                if (dist < 0.1) { // Seuil réduit : 0.1 bloc en 300ms
                    stuckOnLandTicks++;
                } else {
                    stuckOnLandTicks = 0;
                    lastPosition = currentPos.clone();
                }
            } else {
                lastPosition = currentPos.clone();
            }

            if (stuckOnLandTicks > 15) { // ~4.5 secondes avant de réagir (était 1.5s)
                if (stuckOnLandTicks % 10 === 0) { // Log seulement toutes les ~3 secondes
                    console.log(`[Survival] Stuck on land for ${(stuckOnLandTicks * 0.3).toFixed(1)}s. Trying to unstuck.`);
                }
                bot.setControlState('jump', true);
                survivalForcedJump = true;

                // If really stuck, strafe slightly
                if (stuckOnLandTicks > 25) {
                    const strafeState = Math.random() > 0.5 ? 'left' : 'right';
                    bot.setControlState(strafeState, true);
                    setTimeout(() => bot.setControlState(strafeState, false), 500);
                }

                // If EXTREMELY stuck, stop pathfinder to recalculate
                if (stuckOnLandTicks > 40) {
                    console.log(`[Survival] EXTREMELY stuck. Resetting pathfinder.`);
                    bot.pathfinder.stop();
                    stuckOnLandTicks = 0;
                }
            } else {
                // Ne relâcher jump que si c'est Survival qui l'a forcé,
                // sinon on coupe les sauts du pathfinder (towering, parkour)
                if (!inWater && survivalForcedJump) {
                    bot.setControlState('jump', false);
                    survivalForcedJump = false;
                }
            }
        } else {
            // Reset si on n'est plus en déplacement (on mine, on collecte, etc.)
            if (stuckOnLandTicks > 0) stuckOnLandTicks = 0;
            if (survivalForcedJump && !inWater) {
                bot.setControlState('jump', false);
                survivalForcedJump = false;
            }
        }

        if (inWater) {
            inWaterTicks++;

            // Always jump AND sprint when in water to escape currents
            bot.setControlState('jump', true);
            bot.setControlState('sprint', true);

            // ── Décision neuronale pour l'échappement de l'eau ───────────────
            if (survivalBrain && inWaterTicks > 5 && inWaterTicks % 5 === 0) {
                const neuralDecision = survivalBrain.decide(bot, {});
                if (neuralDecision) {
                    const { action } = neuralDecision;
                    if (action === 'JUMP_SWIM') {
                        // Déjà géré (jump+sprint), enregistrement si on sort de l'eau
                        const _inWaterBefore = inWaterTicks;
                        setTimeout(() => {
                            const posNow = bot.entity?.position;
                            if (!posNow) return;
                            const feetNow = bot.blockAt(posNow.floored());
                            const headNow = bot.blockAt(posNow.offset(0, 1.6, 0).floored());
                            const stillInWater = (feetNow?.name?.includes('water')) || (headNow?.name?.includes('water'));
                            if (!stillInWater) survivalBrain.recordSuccess(bot, 'JUMP_SWIM', {});
                        }, 2000);
                    } else if (action === 'BLOCK_WATER' && escapeAttempts <= 3) {
                        // Forcer la stratégie de blocage d'eau plus tôt
                        console.log('[SurvivalBrain] → Priorité au blocage d\'eau');
                        escapeAttempts = 4; // Déclenche la stratégie de blocage
                    } else if (action === 'FIND_LAND' && escapeAttempts < 26) {
                        // Passer directement à la recherche de terre ferme
                        console.log('[SurvivalBrain] → Priorité à la recherche de terre');
                        escapeAttempts = 26;
                    }
                }
            }
            // ─────────────────────────────────────────────────────────────────

            if (inWaterTicks > 5) {
                escapeAttempts++;

                // STRATEGY 0: BLOCK THE WATER CURRENT (if stuck for too long)
                // Cooldown: Only try every 10 seconds
                if (escapeAttempts > 3 && escapeAttempts % 5 === 0 && (Date.now() - lastBlockPlacement >= 10000)) {
                    // Try to place a block to stop the current
                    const blockItems = bot.inventory.items().filter(i =>
                        i.name === 'cobblestone' ||
                        i.name === 'dirt' ||
                        i.name.includes('planks') ||
                        i.name === 'stone'
                    );


                    if (blockItems.length > 0) {
                        try {
                            console.log('[Survival] BLOCKING WATER CURRENT with', blockItems[0].name);
                            await bot.equip(blockItems[0], 'hand');

                            // Scan water blocks around feet to find flow direction
                            const feetPos = pos.floored();
                            const directions = [
                                { dx: 1, dz: 0, name: 'East' },
                                { dx: -1, dz: 0, name: 'West' },
                                { dx: 0, dz: 1, name: 'South' },
                                { dx: 0, dz: -1, name: 'North' }
                            ];

                            let sourceDirection = null;
                            let lowestLevel = 99;

                            // Find water source (lowest level = source block)
                            for (const dir of directions) {
                                const checkPos = feetPos.offset(dir.dx, 0, dir.dz);
                                const checkBlock = bot.blockAt(checkPos);

                                if (checkBlock && checkBlock.name.includes('water')) {
                                    const level = checkBlock.metadata || 0;
                                    if (level < lowestLevel) {
                                        lowestLevel = level;
                                        sourceDirection = dir;
                                    }
                                }
                            }

                            // Fallback to velocity if no water found
                            if (!sourceDirection) {
                                const vel = bot.entity.velocity;
                                if (Math.abs(vel.x) > Math.abs(vel.z)) {
                                    sourceDirection = vel.x > 0 ? { dx: 1, dz: 0, name: 'East' } : { dx: -1, dz: 0, name: 'West' };
                                } else {
                                    sourceDirection = vel.z > 0 ? { dx: 0, dz: 1, name: 'South' } : { dx: 0, dz: -1, name: 'North' };
                                }
                            }

                            console.log(`[Survival] Water source from ${sourceDirection.name} (level ${lowestLevel})`);

                            // Place block at the source to block current
                            const placePos = feetPos.offset(sourceDirection.dx, 0, sourceDirection.dz);
                            const placeBlock = bot.blockAt(placePos);

                            if (placeBlock && placeBlock.name === 'water') {
                                const referenceBlock = bot.blockAt(placePos.offset(0, -1, 0));
                                if (referenceBlock && referenceBlock.name !== 'air') {
                                    await bot.placeBlock(referenceBlock, new (require('vec3'))(0, 1, 0));
                                    console.log('[Survival] Water block placed! Current should stop.');
                                    // Enregistrement récompense : succès si on n'est plus dans l'eau après 2s
                                    if (survivalBrain) {
                                        setTimeout(() => {
                                            const posNow = bot.entity?.position;
                                            if (!posNow) return;
                                            const feetNow = bot.blockAt(posNow.floored());
                                            const headNow = bot.blockAt(posNow.offset(0, 1.6, 0).floored());
                                            const stillInWater = (feetNow?.name?.includes('water')) || (headNow?.name?.includes('water'));
                                            if (!stillInWater) survivalBrain.recordSuccess(bot, 'BLOCK_WATER', {});
                                        }, 2000);
                                    }

                                    // CRITICAL: Blacklist this block to NEVER mine it
                                    const blockKey = `${placePos.x},${placePos.y},${placePos.z}`;
                                    protectedBlocks.add(blockKey);
                                    console.log(`[Survival] Block ${blockKey} protected from mining.`);

                                    // Move AWAY from the placed block (opposite direction)
                                    const escapePos = feetPos.offset(-sourceDirection.dx * 2, 0, -sourceDirection.dz * 2);
                                    const { goals } = require('mineflayer-pathfinder');
                                    bot.pathfinder.setGoal(new goals.GoalBlock(escapePos.x, escapePos.y, escapePos.z));
                                    console.log(`[Survival] Moving away from water block to ${escapePos.x}, ${escapePos.z}`);

                                    // Reset counters - water blocked, bot can continue task
                                    inWaterTicks = 0;
                                    escapeAttempts = 0;

                                    await bot.waitForTicks(20); // Wait 1s for movement
                                    return; // Don't escape, let task continue
                                }
                            }
                        } catch (err) {
                            // Failed to place, continue to next strategy
                        }
                    }
                }

                // Strategy 1: IMMEDIATE PATHFIND TO LAND
                // User requirement: Do NOT build blocks. Just swim out.
                if (escapeAttempts > 0) {
                    // Check if we are already following a path
                    if (bot.pathfinder.isMoving()) {
                        // Let it move
                        return;
                    }

                    const landBlock = bot.findBlock({
                        matching: (block) => {
                            if (!block || !block.position || block.name === 'air' || block.name.includes('water') || block.name.includes('lava')) return false;
                            // Check if there's air above (so bot can stand)
                            const above = bot.blockAt(block.position.offset(0, 1, 0));
                            return above && above.name === 'air';
                        },
                        maxDistance: 32
                    });

                    if (landBlock) {
                        try {
                            const { goals } = require('mineflayer-pathfinder');
                            bot.pathfinder.setGoal(new goals.GoalBlock(landBlock.position.x, landBlock.position.y + 1, landBlock.position.z));
                        } catch (e) { }
                    }
                }

                // Try to place blocks around to block water current - DISABLED
                // if (escapeAttempts > 3 && escapeAttempts % 3 === 0) {
                //    await tryPlaceBlockAround(bot, mcData);
                // }

                // Strategy 2: After 10 attempts, swim straight up aggressively with sprint
                if (escapeAttempts > 10 && escapeAttempts < 25) {
                    console.log(`[Survival] Sprint swimming straight up to surface!`);
                    bot.pathfinder.stop();
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', true);
                    bot.setControlState('jump', true);

                    // Look straight up
                    bot.look(0, -Math.PI / 2, true);
                }

                // Strategy 3: After 25 attempts, find and go to nearest land (reduced from 50)
                if (escapeAttempts > 25) {
                    // Hard limit: reset if stuck for too long (prevents memory issues)
                    if (escapeAttempts > 100) {
                        console.log('[Survival] CRITICAL: Stuck for too long! Force resetting escape attempts.');
                        escapeAttempts = 0;
                        bot.setControlState('forward', false);
                        bot.setControlState('sprint', false);
                        bot.setControlState('jump', true);
                        if (inWaterTicks > 100) {
                            // 5 seconds in water -> stuck?
                            // Panic Place is causing messes. Disabled/Commented out based on user feedback.
                            // The Pathfinder escape above should handle it.
                            /*
                            console.log('[Survival] Stuck in water too long! Trying to build pillar...');
                            await tryPlaceBlockUnderFeet(bot, mcData);
                            inWaterTicks = 0; // Reset timer
                            */
                        }
                        return;
                    }

                    console.log(`[Survival] Stuck too long! Searching for nearest land...`);

                    // Stop current movement
                    bot.pathfinder.stop();
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', true);
                    bot.setControlState('jump', true);

                    // Try to find dry land nearby (INCREASED RANGE)
                    const landBlock = bot.findBlock({
                        matching: (block) => {
                            if (!block || !block.position || block.name === 'air' || block.name.includes('water')) return false;
                            // Must be solid and above water level
                            if (block.position.y < 64) return false;
                            // Check if there's air above (so bot can stand)
                            const above = bot.blockAt(block.position.offset(0, 1, 0));
                            const above2 = bot.blockAt(block.position.offset(0, 2, 0));
                            return above && above.name === 'air' && above2 && above2.name === 'air';
                        },
                        maxDistance: 64, // Doubled from 32
                        count: 1
                    });

                    if (landBlock) {
                        console.log(`[Survival] Found land at ${landBlock.position.x}, ${landBlock.position.y}, ${landBlock.position.z}!`);
                        const targetPos = landBlock.position.offset(0, 1, 0);

                        // Just set a movement goal - don't use pathfinder which would make us swim
                        // Instead, just keep jumping and moving forward manually
                        const direction = targetPos.minus(pos);
                        const yaw = Math.atan2(-direction.x, -direction.z);
                        bot.look(yaw, 0, true);

                        bot.setControlState('forward', true);
                        bot.setControlState('sprint', true);
                        bot.setControlState('jump', true);

                        setTimeout(() => {
                            bot.setControlState('forward', false);
                            escapeAttempts = 0;
                        }, 5000);
                    } else if (lastSafePosition && lastSafePosition.y >= 60) {
                        console.log(`[Survival] No land found nearby, returning to last safe position at ${lastSafePosition.x.toFixed(0)}, ${lastSafePosition.y.toFixed(0)}, ${lastSafePosition.z.toFixed(0)}`);

                        // Manually navigate towards safe position without pathfinder
                        const direction = lastSafePosition.minus(pos);
                        const yaw = Math.atan2(-direction.x, -direction.z);
                        bot.look(yaw, 0, true);

                        bot.setControlState('forward', true);
                        bot.setControlState('sprint', true);
                        bot.setControlState('jump', true);

                        setTimeout(() => {
                            bot.setControlState('forward', false);
                            escapeAttempts = 0;
                        }, 5000);
                    } else {
                        console.log('[Survival] No land or safe position found, continuing to swim up...');
                        escapeAttempts = 0; // Reset to try again
                    }

                    return;
                }

                // Log occasionally
                if (escapeAttempts % 10 === 1) {
                    console.log(`[Survival] Escaping water... attempt ${escapeAttempts}`);
                }
            }
        } else {
            if (inWaterTicks > 5) {
                console.log('[Survival] Escaped from water!');
                escapeAttempts = 0;
            }
            // Ne relâcher jump qu'à la sortie de l'eau (c'est la nage qui l'avait forcé).
            // Le faire à chaque tick écrase les sauts du pathfinder (towering, parkour).
            if (inWaterTicks > 0) {
                bot.setControlState('jump', false);
                bot.setControlState('sprint', false);
            }
            inWaterTicks = 0;
        }
    });

    // Expose safe position for other modules
    bot.getLastSafePosition = () => lastSafePosition;

    // SAFETY OVERRIDE REMOVED - allow free digging for staircase mining
}

// Try to place a block under feet to escape water - build pillar
async function tryPlaceBlockUnderFeet(bot, mcData) {
    const { Vec3 } = require('vec3');

    // Find a block we can place
    const placeableItems = bot.inventory.items().filter(i =>
        i.name === 'dirt' ||
        i.name === 'cobblestone' ||
        i.name === 'stone' ||
        i.name.includes('planks') ||
        i.name === 'sand' ||
        i.name === 'gravel' ||
        i.name === 'netherrack' ||
        i.name.includes('log') ||
        i.name === 'mud' ||
        i.name.includes('deepslate')
    );

    // If no blocks to place, try to mine easy blocks nearby
    if (placeableItems.length === 0) {
        await tryMineEasyBlock(bot, mcData);
        return;
    }

    const item = placeableItems[0];

    try {
        await bot.equip(item, 'hand');
        await bot.look(bot.entity.yaw, Math.PI / 2); // Look down

        bot.setControlState('jump', true);
        await bot.waitForTicks(2);

        const pos = bot.entity.position.floored();

        // Find reference block to place against
        const refPositions = [
            pos.offset(0, -1, 0),
            pos.offset(0, -2, 0),
            pos.offset(1, -1, 0),
            pos.offset(-1, -1, 0),
            pos.offset(0, -1, 1),
            pos.offset(0, -1, -1),
            pos.offset(1, 0, 0),
            pos.offset(-1, 0, 0),
            pos.offset(0, 0, 1),
            pos.offset(0, 0, -1)
        ];

        for (const refPos of refPositions) {
            const refBlock = bot.blockAt(refPos);
            if (refBlock && refBlock.name !== 'air' && !refBlock.name.includes('water')) {
                const targetPos = pos.offset(0, -1, 0);
                const faceVec = targetPos.minus(refPos);

                await bot.placeBlock(refBlock, faceVec);
                console.log('[Survival] Placed block to pillar up!');
                return;
            }
        }
    } catch (e) {
        // Placement failed, keep trying
    }
}

// Try to plug the source of water current
async function tryPlugWaterSource(bot, mcData) {
    const { Vec3 } = require('vec3');

    // Find a block we can place
    const placeableItems = bot.inventory.items().filter(i =>
        i.name === 'dirt' ||
        i.name === 'cobblestone' ||
        i.name === 'stone' ||
        i.name.includes('planks') ||
        i.name === 'netherrack' ||
        i.name.includes('log')
    );

    if (placeableItems.length === 0) return;
    const item = placeableItems[0];

    const pos = bot.entity.position.floored();

    // Check neighbors: Up, North, South, East, West
    // Prioritize UP (ceiling leak)
    const neighbors = [
        pos.offset(0, 2, 0), // Head+1 (Ceiling source?)
        pos.offset(0, 1, 0), // Head level
        pos.offset(1, 1, 0),
        pos.offset(-1, 1, 0),
        pos.offset(0, 1, 1),
        pos.offset(0, 1, -1),
        pos.offset(1, 0, 0),
        pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1),
        pos.offset(0, 0, -1)
    ];

    for (const nPos of neighbors) {
        const block = bot.blockAt(nPos);
        if (block && block.name.includes('water')) {
            // Found water neighbor. Try to plug it.
            // Check if we can place a block there.
            // We need a solid neighbor to place against.
            // But if it's water, we can't click ON the water.
            // We need to click on a SOLID neighbor of `nPos`.

            // Find solid neighbor of the water block
            const waterNeighbors = [
                nPos.offset(1, 0, 0), nPos.offset(-1, 0, 0),
                nPos.offset(0, 1, 0), nPos.offset(0, -1, 0),
                nPos.offset(0, 0, 1), nPos.offset(0, 0, -1)
            ];

            let placed = false;
            for (const wn of waterNeighbors) {
                const support = bot.blockAt(wn);
                if (support && support.boundingBox === 'block' && !support.name.includes('water')) {
                    // Start Plug
                    try {
                        await bot.equip(item, 'hand');
                        await bot.placeBlock(support, nPos.minus(wn));
                        console.log(`[Survival] Plugged water source at ${nPos}!`);
                        placed = true;
                        // Add delay to prevent ADHD
                        await bot.waitForTicks(5);
                        break;
                    } catch (e) { }
                }
            }
            if (placed) return; // Plugged one source, good for this tick.
        }
    }
}

// Try to place blocks around - DISABLED due to causing "water cage" issues
async function tryPlaceBlockAround(bot, mcData) {
    // This logic was trapping the bot in 1x1 water holes. 
    // It is better to swim up or pillar up.
    return;
}

// Try to break surrounding blocks if trapped in water
async function tryBreakCage(bot) {
    const pos = bot.entity.position;
    // Check blocks around head/feet
    const targets = [
        pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1),
        pos.offset(1, 1, 0), pos.offset(-1, 1, 0),
        pos.offset(0, 1, 1), pos.offset(0, 1, -1),
        pos.offset(0, 2, 0) // Ceiling
    ];

    for (const off of targets) {
        const block = bot.blockAt(off.floored());
        if (block && block.boundingBox === 'block') {
            try {
                // Determine if it's a block we recently placed or an obstacle
                // Just break it to free path.
                await bot.dig(block);
                await bot.waitForTicks(10);
                return; // One at a time
            } catch (e) { }
        }
    }
}

// Try to mine easy blocks (dirt, sand, gravel) to get materials for pillaring up
async function tryMineEasyBlock(bot, mcData) {
    const pos = bot.entity.position;

    // Check if bot is underwater
    const feetBlock = bot.blockAt(pos.floored());
    const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());
    const isUnderwater = (feetBlock && feetBlock.name.includes('water')) ||
        (headBlock && headBlock.name.includes('water'));

    // If underwater, don't try to mine - just swim up
    if (isUnderwater) {
        bot.setControlState('jump', true);
        bot.setControlState('forward', false);
        return;
    }

    // Blocks that are easy to break by hand (fast)
    const easyBlocks = [
        'dirt', 'sand', 'gravel', 'clay', 'mud',
        'soul_sand', 'soul_soil', 'grass_block',
        'podzol', 'mycelium', 'coarse_dirt', 'rooted_dirt'
    ];

    // Search around for easy blocks - prioritize above and sides, NOT below
    const searchPositions = [
        // Above (best for escape)
        pos.offset(0, 1, 0),
        pos.offset(0, 2, 0),
        pos.offset(1, 1, 0),
        pos.offset(-1, 1, 0),
        pos.offset(0, 1, 1),
        pos.offset(0, 1, -1),
        // Same level (sides)
        pos.offset(1, 0, 0),
        pos.offset(-1, 0, 0),
        pos.offset(0, 0, 1),
        pos.offset(0, 0, -1),
    ];

    for (const searchPos of searchPositions) {
        const block = bot.blockAt(searchPos.floored());
        if (!block || block.name === 'water' || block.name === 'air') continue;

        // Check if it's an easy block
        const isEasy = easyBlocks.some(e => block.name.includes(e));
        if (isEasy) {
            try {
                console.log(`[Survival] Mining ${block.name}...`);
                await bot.dig(block);

                // Wait briefly for item to drop and auto-pickup
                await bot.waitForTicks(5);

                // Now try to place a block under feet immediately
                const placeableItems = bot.inventory.items().filter(i =>
                    i.name === 'dirt' || i.name === 'sand' || i.name === 'gravel' ||
                    i.name === 'cobblestone' || i.name.includes('planks')
                );

                if (placeableItems.length > 0) {
                    const item = placeableItems[0];
                    await bot.equip(item, 'hand');
                    await bot.look(bot.entity.yaw, Math.PI / 2); // Look down

                    // Jump and place
                    bot.setControlState('jump', true);
                    await bot.waitForTicks(3);

                    const currentPos = bot.entity.position.floored();
                    const refBlock = bot.blockAt(currentPos.offset(0, -1, 0));
                    if (refBlock && refBlock.name !== 'air') {
                        try {
                            await bot.placeBlock(refBlock, new (require('vec3'))(0, 1, 0));
                            console.log('[Survival] Placed block to escape!');
                        } catch (e) { }
                    }
                }
                return;
            } catch (e) {
                // Continue to next block
            }
        }
    }

    // If no easy blocks found, just swim upward aggressively
    bot.setControlState('jump', true);
    bot.setControlState('forward', false);
}

// Check if a position is safe (not in water/lava)
function isSafePosition(bot, pos) {
    const block = bot.blockAt(pos);
    const blockBelow = bot.blockAt(pos.offset(0, -1, 0));

    if (!block || !blockBelow) return false;

    const dangerousBlocks = ['water', 'lava', 'fire', 'cactus', 'magma_block'];

    if (dangerousBlocks.some(d => block.name.includes(d))) return false;
    if (dangerousBlocks.some(d => blockBelow.name.includes(d))) return false;

    return true;
}

// Equip the best weapon for combat
async function equipBestWeapon(bot) {
    const inv = bot.inventory.items();
    const sword = inv.find(item => item.name.includes('sword'));
    const axe = inv.find(item => item.name.includes('axe'));

    // Prefer sword, then axe
    const weapon = sword || axe;

    if (weapon) {
        try {
            await bot.equip(weapon, 'hand');
            return true;
        } catch (e) {
            console.log(`[Survival] Failed to equip weapon: ${e.message}`);
            return false;
        }
    }
    return false;
}

// Configure pathfinder to avoid water and NOT dig under feet
// Configure pathfinder to avoid water and NOT dig under feet
function configurePathfinder(bot) {
    const { Movements } = require('mineflayer-pathfinder');
    const mcData = require('minecraft-data')(bot.version);

    const movements = new Movements(bot, mcData);

    // IMPORTANT: Don't dig blocks under feet
    movements.canDig = true;
    movements.allow1by1towers = true;
    movements.dontCreateFlow = true;
    movements.dontMineUnderFallingBlock = true;

    // IDs d'ITEMS (pas de blocs) : le pathfinder compare à item.type dans l'inventaire
    movements.scafoldingBlocks = [
        mcData.itemsByName.cobblestone?.id,
        mcData.itemsByName.dirt?.id,
        mcData.itemsByName.netherrack?.id
    ].filter(id => id !== undefined);

    // Protect Crafting Table and Furnace
    if (mcData.blocksByName.crafting_table) {
        movements.blocksCantBreak.add(mcData.blocksByName.crafting_table.id);
    }
    if (mcData.blocksByName.furnace) {
        movements.blocksCantBreak.add(mcData.blocksByName.furnace.id);
    }

    // Strongly avoid water - treat it as if it's a solid wall
    if (mcData.blocksByName.water) {
        movements.blocksCantBreak.add(mcData.blocksByName.water.id);
        movements.blocksToAvoid.add(mcData.blocksByName.water.id);
    }
    if (mcData.blocksByName.lava) {
        movements.blocksToAvoid.add(mcData.blocksByName.lava.id);
        movements.blocksCantBreak.add(mcData.blocksByName.lava.id);
    }

    // Don't swim
    movements.canSwim = false;

    // Add custom safeToBreak to prevent paths through water
    const originalSafeToBreak = movements.safeToBreak;
    movements.safeToBreak = function (block) {
        if (!block) return false;

        // Never consider crafting table or furnace safe to break
        if (block.name === 'crafting_table' || block.name === 'furnace') return false;

        // Never consider water or lava safe to break/walk through
        if (block.name === 'water' || block.name === 'lava') {
            return false;
        }

        return originalSafeToBreak ? originalSafeToBreak.call(this, block) : true;
    };

    // Patch: protéger safeOrBreak contre les blocs dans des chunks non chargés (block.digTime undefined)
    const originalSafeOrBreak = movements.safeOrBreak;
    if (originalSafeOrBreak) {
        movements.safeOrBreak = function(block, ...args) {
            if (!block || typeof block.digTime !== 'function') return 0;
            return originalSafeOrBreak.call(this, block, ...args);
        };
    }

    bot.pathfinder.setMovements(movements);
    console.log('[Survival] Pathfinder configured: avoid water/lava completely, no digging under feet, preserve tables/furnaces');
}

module.exports = { setupSurvival, configurePathfinder, protectedBlocks };
