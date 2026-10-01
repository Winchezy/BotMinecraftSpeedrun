// Survival utilities for the bot

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { disableDiagonalMoves, findBlockingStep, findCardinalWaypoint, existingPassageMovements } = require('./Pathing');
const { isHostileMob, isNeutralMob, decideResponse, MobAwareness } = require('./MobThreats');
const { routeThreats, threatNearPath, hasMobAccess } = require('./MobSafety');
const { equipDefense, guardWithShield } = require('./Defense');
const { constrainCombat } = require('./SurvivalPolicy');

// Last safe position tracking (Module Scope)
let lastSafePosition = null;
let lastSafePositionTime = Date.now();

// Protected blocks (water blockers) that should NEVER be mined
const protectedBlocks = new Set(); // Store as "x,y,z" strings

function setupSurvival(bot) {
    const tactics = new (require('./CombatTactics'))(bot);
    const awareness = new MobAwareness(bot);
    bot.mobAwareness = awareness;
    let lastAwarenessChat = 0;
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

    // GetFood gere seul les repas et la cuisson, sans consommation concurrente.
    bot.on('health', () => {
        if (bot.health < 5) {
            console.log(`[Survival] Low health: ${bot.health}/20`);

        }
        if (bot.food < 5) {
            console.log(`[Survival] Hungry: ${bot.food}/20`);
        }
    });

    // Only attack normally hostile mobs at close range. Neutral mobs are never
    // attacked by the survival system, even after ambiguous damage events.
    let combatMode = null; // 'fight' or 'retreat'
    let combatTarget = null;
    let combatLease = null;
    let lastDamageTime = 0;
    let lastRetreatTime = 0;
    let checkingThreat = false;
    let urgentPending = false;
    let retreatStall = null;
    bot.on('death', () => {
        tactics.reset();
        if (combatMode === 'fight') bot.pvp.stop();
        combatMode = null;
        combatTarget = null;
        retreatStall = null;
        bot.shieldStoppedChase = false;
        bot.deactivateItem();
    });

    // React to damage (e.g. being shot by skeleton)
    bot.on('entityHurt', (entity, source) => {
        if (entity !== bot.entity) return;
        if (bot.food===0 && !source) {
            bot.lastStarvationDamage = Date.now();
            console.log('[Survival] Degats sans attaquant identifie a faim nulle : priorite nourriture.');
            // Ne pas attribuer automatiquement la famine aux mobs lointains.
            // Les attaques identifiees et la surveillance reguliere restent actives.
            return;
        }
        awareness.markAttack(source);
        bot.threatRevision = (bot.threatRevision || 0) + 1;
        lastDamageTime = Date.now();
        console.log('[Survival] Ouch! Took damage. Scanning for threats...');
        checkForThreats(true);
    });

    let lastThreatCheck = 0;
    const clearThreat = () => {
        if (!combatMode) return;
        if (bot.actions) {
            if (bot.actions.valid(combatLease)) bot.actions.cancel('Menace terminee');
            tactics.jumpTicks = 0;
            tactics.dodgeTicks = 0;
            combatMode = null;
            combatTarget = null;
            combatLease = null;
            bot.shieldStoppedChase = false;
            console.log('[Survival] Threat cleared. Resuming duties.');
            return;
        }
        tactics.reset();
        if (combatMode === 'fight') bot.pvp.stop();
        if (combatMode === 'retreat') bot.pathfinder.stop();
        combatMode = null;
        combatTarget = null;
        bot.shieldStoppedChase = false;
        bot.deactivateItem();
        console.log('[Survival] Threat cleared. Resuming duties.');
    };

    const checkForThreats = async (urgent = false) => {
        const now = Date.now();
        if (checkingThreat) { if (urgent) urgentPending = true; return; }
        if (!urgent && now - lastThreatCheck < 200) return;
        checkingThreat = true;
        lastThreatCheck = now;
        try {
            if (!bot.entity) return;
            const distanceTo = entity => bot.entity.position.distanceTo(entity.position);
            const states = new Map();
            for (const entity of Object.values(bot.entities)) {
                if (!entity?.position || !(isHostileMob(entity) || isNeutralMob(entity)) || distanceTo(entity) > 32) continue;
                const previous = awareness.observations.get(entity.id)?.state;
                const observed = awareness.observe(entity, now);
                states.set(entity.id, observed);
                if (previous !== observed.state) {
                    console.log(`[MobAwareness] ${entity.name}: ${observed.state}, ${observed.distance.toFixed(1)} blocs (${observed.evidence}).`);
                    if (observed.state === 'hostile' && now - lastAwarenessChat > 3000) {
                        lastAwarenessChat = now;
                        const message = observed.evidence === 'poursuite probable' ?
                            `Un ${entity.name} semble s'approcher de moi.` :
                            observed.evidence === 'attaque recue' ?
                                `Un ${entity.name} m'attaque.` :
                                `Un ${entity.name} montre des signes d'agressivite.`;
                        bot.chat(`[SpeedBot] ${message}`);
                    }
                }
            }
            awareness.prune(now);
            const hostile = bot.nearestEntity(entity => isHostileMob(entity) && distanceTo(entity) < 18 &&
                states.get(entity.id)?.state !== 'passive' &&
                (now - lastDamageTime < 3000 || hasMobAccess(bot, bot.entity.position, entity)));
            const recentlyHurt = now - lastDamageTime < 3000;
            const neutral = bot.nearestEntity(entity => isNeutralMob(entity) && distanceTo(entity) < 18 &&
                (states.get(entity.id)?.state === 'hostile' || recentlyHurt && distanceTo(entity) < 4) &&
                hasMobAccess(bot, bot.entity.position, entity));
            // A nearby neutral is a possible attacker after damage. Give it space,
            // but never turn that uncertainty into an attack.
            const attacker = Object.values(bot.entities).find(entity => entity?.position &&
                distanceTo(entity) < 18 && (isHostileMob(entity) || isNeutralMob(entity)) &&
                awareness.observations.get(entity.id)?.attackedAt != null &&
                now - awareness.observations.get(entity.id).attackedAt < 10000);
            const target = attacker || (hostile && distanceTo(hostile) < 5 ? hostile : (neutral || hostile));
            const nearbyHostiles = Object.values(bot.entities).filter(entity =>
                isHostileMob(entity) && states.get(entity.id)?.state === 'hostile' && distanceTo(entity) < 16 && hasMobAccess(bot, bot.entity.position, entity)
            ).length;
            const armed = bot.inventory.items().some(item => /_(sword|axe)$/.test(item.name));
            let action = target ? decideResponse(target, {
                distance: distanceTo(target), health: bot.health, armed,
                nearbyHostiles, recentDamage: recentlyHurt, threatState: states.get(target.id)?.state
            }) : 'ignore';
            if (hostile && nearbyHostiles >= 2 && distanceTo(hostile) < 16) action = 'retreat';
            if (target && bot.mobBlockedSince && now - bot.mobBlockedSince >= 30000 &&
                now - (bot.lastMobBlock || 0) < 60000 &&
                isHostileMob(target) && !['creeper', 'warden', 'ravager', 'piglin_brute', 'ghast'].includes(target.name) &&
                bot.inventory.items().some(i => i.name.endsWith('_sword')) && bot.health >= 10 &&
                nearbyHostiles < 2 && distanceTo(target) <= (target.name === 'blaze' ? 4 : 10) &&
                states.get(target.id)?.state === 'hostile' && hasMobAccess(bot, bot.entity.position, target)) action = 'fight';
            if (attacker) {
                const gear = { shield: bot.inventory.items().some(i => i.name === 'shield'), weapon: armed };
                if (gear.shield && gear.weapon && bot.health >= 7 && nearbyHostiles < 2 &&
                    isHostileMob(attacker) && !['creeper', 'warden', 'ravager', 'piglin_brute', 'ghast'].includes(attacker.name) &&
                    distanceTo(attacker) <= (attacker.name === 'blaze' ? 4 : 10) &&
                    hasMobAccess(bot, bot.entity.position, attacker)) action = 'fight';
            }

            if (action === 'retreat') {
                if (!retreatStall || now - retreatStall.lastSeen > 10000 || retreatStall.target !== target.id ||
                    bot.entity.position.distanceTo(retreatStall.position) >= 1) {
                    retreatStall = { target: target.id, position: bot.entity.position.clone(), since: now, lastSeen: now };
                }
                retreatStall.lastSeen = now;
                if (require('./MobThreats').shouldFightStalemate(target, {
                    stuckMs: now - retreatStall.since, distance: distanceTo(target), health: bot.health,
                    sword: bot.inventory.items().some(i => i.name.endsWith('_sword')),
                    nearbyHostiles, threatState: states.get(target.id)?.state
                }) && hasMobAccess(bot, bot.entity.position, target)) {
                    if (combatMode !== 'fight' || combatTarget !== target) {
                        console.log(`[Survival] Fuite bloquee depuis 30 s : defense contre ${target.name}.`);
                    }
                    action = 'fight';
                }
            }

            action = constrainCombat(bot, action);
            if (action === 'ignore') {
                clearThreat();
                return;
            }
            if (bot.actions) {
                const previous = combatLease;
                combatLease = bot.actions.acquire('combat', 80);
                if (!combatLease) return;
                if (previous !== combatLease) { combatMode = null; combatTarget = null; }
            }
            const respond = async () => {
            if (attacker) {
                const gear = await equipDefense(bot);
                if (gear.shield) {
                    await bot.lookAt(attacker.position.offset(0, 1, 0), true);
                    if (combatMode !== 'fight') bot.activateItem(true);
                }
            }
            if (action === 'retreat') {
                await equipDefense(bot);
                if (combatMode === 'fight') bot.pvp.stop();
                if (combatMode !== 'retreat' || combatTarget !== target) {
                    console.log(`[Survival] Avoiding ${target.name} at ${distanceTo(target).toFixed(1)} blocks.`);
                }
                combatMode = 'retreat';
                combatTarget = target;
                if (now - lastRetreatTime > 2500) {
                    lastRetreatTime = now;
                    await retreat(bot, target);
                }
                return;
            }
            if (combatMode === 'fight' && combatTarget === target) {
                await equipDefense(bot);
                return;
            }
            if (combatMode === 'retreat') bot.pathfinder.stop();
            await equipDefense(bot);
            bot.pathfinder.stop();
            bot.pvp.stop();
            combatMode = 'fight';
            combatTarget = target;
            console.log(`[Survival] Defending against nearby ${target.name}.`);
            bot.pvp.movements = existingPassageMovements(bot);
            bot.pvp.movements.allowParkour = false;
            bot.pvp.movements.allowSprinting = false;
            bot.pvp.movements.canSwim = false;
            bot.pvp.movements.maxDropDown = 1;
            await bot.pvp.attack(target);
            if (bot.inventory.items().some(i => i.name === 'shield')) bot.activateItem(true);
            };
            if (bot.actions) await bot.actions.with(combatLease, respond);
            else await respond();
        } catch (e) {
            if (e.code !== 'ACTION_INTERRUPTED') console.error('[Survival] Threat Check Error:', e);
        } finally {
            checkingThreat = false;
            if (urgentPending) {
                urgentPending = false;
                setImmediate(() => checkForThreats(true));
            }
        }
    };

    let guarding = false;
    bot.on('physicsTick', async () => {
        if (guarding || !combatMode || !combatTarget) return;
        guarding = true;
        try {
            const defend = async () => {
                await guardWithShield(bot, combatTarget, combatMode);
                tactics.tick(combatMode, combatTarget);
            };
            if (bot.actions) await bot.actions.with(combatLease, defend);
            else await defend();
        }
        catch (error) { if (error.code !== 'ACTION_INTERRUPTED') console.log(`[Survival] Bouclier: ${error.message}`); }
        finally { guarding = false; }
    });

    async function retreat(bot, enemy) {
        const revision = bot.threatRevision || 0;
        if (bot.retreatProgress && bot.entity.position.distanceTo(bot.retreatProgress.position)>0.2)
            bot.retreatProgress={position:bot.entity.position.clone(),time:Date.now()};
        if (bot.pathfinder.isMoving() && bot.retreatTarget && bot.retreatProgress &&
            Date.now()-bot.retreatProgress.time<3000 && bot.entity.position.distanceTo(bot.retreatTarget)>1.5) return;
        const escape=await require('./RetreatRoute').findRetreatRoute(bot,[...routeThreats(bot),enemy]);
        if ((bot.threatRevision || 0) !== revision) return;
        if (escape) {
            bot.retreatTarget=escape.target;
            bot.retreatProgress={position:bot.entity.position.clone(),time:Date.now()};
            bot.pathfinder.setMovements(escape.movements);
            console.log(`[Survival] Fuite accessible de ${bot.entity.position} vers ${escape.target}.`);
            bot.pathfinder.setGoal(escape.goal);
            return;
        }
        const origin = bot.entity.position;
        const threats = [...routeThreats(bot), enemy];
        let best = null;
        let fallback = null;
        const clearance = point => Math.min(...threats.map(t =>
            Math.abs(point.y - t.position.y) > 4 ? 100 :
                Math.hypot(point.x - t.position.x, point.z - t.position.z)));
        const initialClearance = clearance(origin);
        for (let i = 0; i < 8; i++) {
            const angle = 2 * Math.PI * i / 8;
            const point = origin.offset(Math.cos(angle) * 12, 0, Math.sin(angle) * 12);
            const nearest = clearance(point);
            const goal = new goals.GoalNearXZ(point.x, point.z, 2);
            const route = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, 100);
            if (route.path.length < 2 || route.path.some(step => step.y < origin.y - 1)) continue;
            const laterSteps = route.path.slice(1, 12);
            const worstClearance = Math.min(...laterSteps.map(clearance));
            const score = nearest + worstClearance * 2 - route.path.length * 0.2;
            if (!fallback || score > fallback.score) fallback = { goal, score };
            if (route.status !== 'success' ||
                worstClearance < initialClearance - 0.5) continue;
            if (!best || score > best.score) best = { goal, score };
        }
        if (!best) console.log('[Survival] No complete retreat path; choosing the least exposed partial route.');
        if (best || fallback) bot.pathfinder.setGoal((best || fallback).goal);
        else bot.pathfinder.stop();
    }

    let lastCrowdWarning = 0;
    bot.on('path_update', result => {
        if (bot.actions?.current && bot.actions.current.owner !== 'agent') return;
        if (combatMode || !result.path?.length) return;
        if (bot.isFoodExploring && !require('./ExplorationSafety').safeExplorationPath(bot,result.path)) {
            console.log('[Survival] Exploration arretee : bord expose ou support incertain.');
            if (bot.actions) bot.actions.cancel('Trajet d exploration dangereux');
            else { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
            return;
        }
        const threat = threatNearPath(bot, result.path);
        if (!threat) return;
        if (Date.now() - lastCrowdWarning > 5000) {
            lastCrowdWarning = Date.now();
            console.log(`[Survival] Unsafe path near ${threat.name}; replanning away from mobs.`);
            try { bot.chat(`[SpeedBot] Trajet refuse: mobs proches (${threat.name}).`); } catch (_) { }
        }
        if (bot.actions) bot.actions.cancel('Trajet expose aux mobs');
        else bot.pathfinder.stop();
    });

    // Check threats periodically
    const threatTimer = setInterval(() => checkForThreats(false), 200);
    bot.once('end', () => clearInterval(threatTimer));

    // Expose combat state
    bot.isInCombat = () => combatMode !== null;

    // Safe position tracking - save position when NOT in water + check for falling blocks
    let hazardBusy = false;
    let safeCheckInterval = setInterval(async () => {
        if (!bot.entity) return;

        const pos = bot.entity.position;
        const feetBlock = bot.blockAt(pos.floored());
        const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));

        // CRITICAL: Check for falling blocks (gravel/sand) above
        for (let y = 1; y <= 3; y++) {
            const blockAbove = bot.blockAt(pos.offset(0, y, 0).floored());
            const falling = Object.values(bot.entities).some(e => e.name === 'falling_block' && e.position?.distanceTo(pos) < 3);
            if (!hazardBusy && falling && blockAbove && (blockAbove.name === 'gravel' || blockAbove.name === 'sand')) {
                console.log(`[Survival] DANGER: ${blockAbove.name} detected ${y} blocks above! Moving away!`);
                // Move sideways immediately
                const target = [[1,0],[-1,0],[0,1],[0,-1]].map(([x,z]) => pos.floored().offset(x,0,z))
                    .find(p => bot.blockAt(p)?.boundingBox === 'empty' && bot.blockAt(p.offset(0,1,0))?.boundingBox === 'empty' &&
                        require('./ExplorationSafety').safeExplorationStep(bot,p));
                if (!target) break;
                hazardBusy = true;
                const escape = async () => {
                    bot.pathfinder.setMovements(existingPassageMovements(bot));
                    await require('./Pathing').withTimeout(bot,bot.pathfinder.goto(new goals.GoalBlock(target.x,target.y,target.z)),2000,'Bloc tombant');
                };
                try {
                    if (bot.actions) await bot.actions.run('danger',110,escape);
                    else await escape();
                } catch (error) { console.log(`[Survival] Evasion: ${error.message}`); }
                finally { hazardBusy = false; }
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
    bot.once('end', () => clearInterval(safeCheckInterval));


    // Water escape system AND Stuck-On-Land Detection
    let lastWaterCheck = Date.now();
    const waterEscape = new (require('./WaterEscape'))(bot);
    let inWaterTicks = 0;
    let escapeAttempts = 0;
    let lastBlockPlacement = 0; // Cooldown for water blocking
    let activePath = [];
    let lastProgress = null;
    let lastProgressTime = Date.now();
    let lastStallReport = 0;
    let clearingStep = false;
    let lastClearAttempt = 0;
    let lastWaypointAttempt = 0;
    bot.on('path_update', result => { activePath = result.path; });

    bot.on('physicsTick', () => {
        if (bot.actions?.current && bot.actions.current.owner !== 'agent') return;
        if (!bot.isFoodExploring || !bot.entity?.onGround || !bot.pathfinder.isMoving()) return;
        const velocity = bot.entity.velocity;
        const speed = Math.hypot(velocity.x,velocity.z);
        if (speed < 0.02) return;
        const next = bot.entity.position.offset(velocity.x/speed*0.65,0,velocity.z/speed*0.65).floored();
        if (!require('./ExplorationSafety').safeExplorationProbe(bot,next,activePath)) {
            console.log('[Survival] Exploration arretee avant un bord dangereux.');
            if (bot.actions) bot.actions.cancel('Bord dangereux en exploration');
            else { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
        }
    });

    bot.on('physicsTick', async () => {
        if (Date.now() - lastWaterCheck < 300) return;
        lastWaterCheck = Date.now();

        const pos = bot.entity.position;
        const feetBlock = bot.blockAt(pos.floored());
        const headBlock = bot.blockAt(pos.offset(0, 1.6, 0).floored());

        const inWater = (feetBlock && feetBlock.name.includes('water')) ||
            (headBlock && headBlock.name.includes('water'));
        if (inWater) { await waterEscape.tick(true); return; }
        await waterEscape.tick(false);
        if (bot.isInCombat?.() || bot.targetDigBlock || bot.pathfinder.isMining()) return;

        if (bot.pathfinder.isMoving() && !inWater) {
            if (!lastProgress || pos.distanceTo(lastProgress) > 0.2) {
                lastProgress = pos.clone();
                lastProgressTime = Date.now();
            } else if (Date.now() - lastProgressTime > 3000 && Date.now() - lastStallReport > 5000) {
                lastStallReport = Date.now();
                const next = activePath[0];
                console.log(`[Survival] Path stalled at ${pos}, next=${next ? `${next.x},${next.y},${next.z}` : 'none'}, onGround=${bot.entity.onGround}, forward=${bot.getControlState('forward')}, jump=${bot.getControlState('jump')}`);
                if (!clearingStep && Date.now() - lastProgressTime > 4000 &&
                    Date.now() - lastClearAttempt > 30000) {
                    const obstacle = findBlockingStep(bot, pos, next);
                    if (obstacle) {
                        clearingStep = true;
                        bot.isClearingObstacle = true;
                        lastClearAttempt = Date.now();
                        console.log(`[Survival] Clearing blocking ${obstacle.name} at ${obstacle.position}.`);
                        const clearObstacle = async () => {
                        bot.pathfinder.stop();
                        try {
                            const tool = bot.pathfinder.bestHarvestTool(obstacle);
                            if (tool) await bot.equip(tool, 'hand');
                            await bot.dig(obstacle, true);
                        } catch (error) {
                            console.log(`[Survival] Could not clear obstacle: ${error.message}`);
                        } finally {
                            bot.isClearingObstacle = false;
                            clearingStep = false;
                        }
                        };
                        try {
                            if (bot.actions) await bot.actions.run('obstacle',40,clearObstacle);
                            else await clearObstacle();
                        } finally { clearingStep = false; bot.isClearingObstacle = false; }
                    } else if (!bot.actions && Date.now() - lastWaypointAttempt > 8000) {
                        const waypoint = findCardinalWaypoint(bot, pos, next);
                        if (waypoint) {
                            lastWaypointAttempt = Date.now();
                            console.log(`[Survival] Aligning through safe step ${waypoint} before diagonal target.`);
                            bot.pathfinder.setGoal(new goals.GoalBlock(waypoint.x, waypoint.y, waypoint.z));
                        }
                    }
                }
            }
        } else {
            lastProgress = null;
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
    bot.pathfinder.searchRadius = 32;
    bot.pathfinder.thinkTimeout = 1500;
    const { Movements } = require('mineflayer-pathfinder');
    const mcData = require('minecraft-data')(bot.version);

    const movements = new Movements(bot, mcData);

    // IMPORTANT: Don't dig blocks under feet
    movements.canDig = true;
    movements.allow1by1towers = true;
    movements.dontCreateFlow = true;
    movements.dontMineUnderFallingBlock = true;

    movements.scafoldingBlocks = [
        mcData.blocksByName.cobblestone?.id,
        mcData.blocksByName.dirt?.id,
        mcData.blocksByName.netherrack?.id
    ];

    // Protect Crafting Table
    if (mcData.blocksByName.crafting_table) {
        movements.blocksCantBreak.add(mcData.blocksByName.crafting_table.id);
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
    movements.maxDropDown = 1;
    movements.allowParkour = false;
    movements.entityCost = 25;
    for (const name of ['zombie', 'husk', 'drowned', 'skeleton', 'stray',
        'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime',
        'pillager', 'vindicator', 'ravager', 'blaze', 'hoglin', 'warden']) {
        movements.entitiesToAvoid.add(name);
    }

    // A diagonal between two solid blocks can be considered valid by the planner
    // even though the player hitbox cannot pass the corner. Use cardinal steps.
    disableDiagonalMoves(movements);
    // The pathfinder's post-processing can reintroduce diagonal shortcuts.
    bot.pathfinder.enablePathShortcut = false;

    // Add custom safeToBreak to prevent paths through water
    const originalSafeToBreak = movements.safeToBreak;
    movements.safeToBreak = function (block) {
        if (!block || typeof block.digTime !== 'function') return false;

        // Never consider crafting table safe to break
        if (block.name === 'crafting_table') return false;

        // Never consider water or lava safe to break/walk through
        if (block.name === 'water' || block.name === 'lava') {
            return false;
        }

        return originalSafeToBreak ? originalSafeToBreak.call(this, block) : true;
    };

    bot.pathfinder.setMovements(movements);
    console.log('[Survival] Pathfinder configured: avoid water/lava completely, no digging under feet, preserve tables');
}

module.exports = { setupSurvival, configurePathfinder, protectedBlocks };
