const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { disableDiagonalMoves, planCompletePath } = require('./Pathing');
const { isHostileMob } = require('./MobThreats');
const fs = require('fs');
const path = require('path');

const DANGEROUS_BLOCKS = /water|lava|fire|magma|cactus|campfire|berry_bush|powder_snow|sweet_berry/;
const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class DeathRecovery {
    constructor(bot, { persist = true } = {}) {
        this.bot = bot;
        this.pending = null;
        this.ready = false;
        this.running = false;
        this.generation = 0;
        this.retryAt = 0;
        this.visitedWaypoints = new Map();
        if (persist && bot.username) {
            this.filename = path.join(__dirname,'../../.bot-state',`death-${bot.username.replace(/[^a-z0-9_-]/gi,'_')}.json`);
            try {
                const saved = JSON.parse(fs.readFileSync(this.filename,'utf8'));
                if (saved && saved.server === this.serverKey() && Date.now()-saved.time < 1800000 &&
                    [saved.position.x,saved.position.y,saved.position.z].every(Number.isFinite)) {
                    this.pending = {...saved,position:new Vec3(saved.position.x,saved.position.y,saved.position.z)};
                    this.ready = true;
                }
            } catch (_) {}
        }
    }

    serverKey() {return `${this.bot._client?.socket?.remoteAddress}:${this.bot._client?.socket?.remotePort}`;}
    save() {
        if (!this.filename) return;
        try {
            fs.mkdirSync(path.dirname(this.filename),{recursive:true});
            fs.writeFileSync(this.filename+'.tmp',JSON.stringify(this.pending));
            fs.renameSync(this.filename+'.tmp',this.filename);
        } catch(error) {console.log(`[DeathRecovery] Sauvegarde impossible : ${error.message}`);}
    }

    onDeath() {
        this.generation++;
        this.pending = this.bot.entity?.position
            ? { position: this.bot.entity.position.clone(), dimension: this.bot.game.dimension,time:Date.now(),server:this.serverKey() }
            : null;
        this.ready = false;
        this.retryAt = 0;
        this.visitedWaypoints.clear();
        this.save();
        if (this.pending) console.log(`[DeathRecovery] Mort en ${this.pending.dimension} a ${this.pending.position}.`);
        else console.log('[DeathRecovery] Position de mort indisponible.');
    }

    onSpawn() {
        if (this.pending) this.ready = true;
    }

    checkActive(generation) {
        if (generation !== this.generation || !this.pending || !this.bot.entity) {
            throw new Error('Nouvelle mort ou deconnexion');
        }
        if (this.bot.isInCombat?.()) throw new Error('Combat en cours : priorite a la survie');
    }

    hostileNear(position, radius) {
        return Object.values(this.bot.entities).find(entity =>
            entity?.position && isHostileMob(entity) &&
            entity.position.distanceTo(position) < radius
        );
    }

    threatNearCurrent(position) {
        return Object.values(this.bot.entities).find(entity => {
            if (!entity?.position || !isHostileMob(entity)) return false;
            const distance = entity.position.distanceTo(position);
            if (distance >= 10) return false;
            // Survival only retreats from a vigilant creeper inside six blocks.
            // Beyond that range it leaves control to recovery; keep the wider
            // exclusion around destinations so a route cannot approach it.
            if (entity.name === 'creeper' && distance >= 6 &&
                this.bot.mobAwareness?.observations.get(entity.id)?.state === 'vigilance') return false;
            return true;
        });
    }

    block(x, y, z) {
        return this.bot.blockAt(new Vec3(x, y, z));
    }

    standable(x, y, z) {
        const ground = this.block(x, y - 1, z);
        const feet = this.block(x, y, z);
        const head = this.block(x, y + 1, z);
        return ground && feet && head && ground.boundingBox === 'block' &&
            feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
            !DANGEROUS_BLOCKS.test(ground.name) &&
            !DANGEROUS_BLOCKS.test(feet.name) && !DANGEROUS_BLOCKS.test(head.name);
    }

    // Reject ledges and steep ground around the landing cell.
    stableGround(x, y, z) {
        if (!this.standable(x, y, z)) return false;
        let accessibleNeighbors = 0;
        for (const [dx, dz] of OFFSETS) {
            let neighbor = false;
            for (const dy of [0, 1, -1]) {
                if (this.standable(x + dx, y + dy, z + dz)) {
                    neighbor = true;
                    break;
                }
            }
            if (neighbor) accessibleNeighbors++;
        }
        return accessibleNeighbors >= 3;
    }

    safeCellNear(center, radius, verticalRange, deathPosition = null) {
        const cx = Math.floor(center.x);
        const cy = Math.floor(center.y);
        const cz = Math.floor(center.z);
        const candidates = [];
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx * dx + dz * dz > radius * radius) continue;
                for (let dy = -verticalRange; dy <= verticalRange; dy++) {
                    const x = cx + dx, y = cy + dy, z = cz + dz;
                    const p = new Vec3(x + 0.5, y, z + 0.5);
                    if (!this.stableGround(x, y, z)) continue;
                    // Stay close enough to the dropped items without stepping into the hazard.
                    if (deathPosition && p.distanceTo(deathPosition) > 3.5) continue;
                    candidates.push({ position: p, score: p.distanceTo(center) + Math.abs(dy) * 0.5 });
                }
            }
        }
        candidates.sort((a, b) => a.score - b.score);
        return candidates[0]?.position || null;
    }

    safeMovements() {
        const mcData = require('minecraft-data')(this.bot.version);
        const movements = new Movements(this.bot, mcData);
        // Ouvrir le feuillage peut etre necessaire pour quitter la foret.
        // Le sol et les blocs de terrain restent proteges.
        movements.canDig = true;
        movements.safeToBreak = block => {
            if (!block?.position || block.position.y < Math.floor(this.bot.entity.position.y)) return false;
            if (!/^(dirt|coarse_dirt|grass_block|mossy_cobblestone|cobblestone|stone|andesite|diorite|granite)$|_(leaves|log)$/.test(block.name)) return false;
            const {threatNearPoint} = require('./MobSafety');
            if (threatNearPoint(this.bot,block.position,2)) return false;
            return ![[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]].some(([x,y,z])=>{
                const neighbor=this.bot.blockAt(block.position.offset(x,y,z));
                return !neighbor || /water|lava|sand|gravel/.test(neighbor.name);
            });
        };
        movements.canSwim = false;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        movements.allowSprinting = false;
        movements.maxDropDown = 1;
        for (const name of ['water', 'lava', 'fire', 'soul_fire', 'magma_block',
            'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'powder_snow']) {
            const id = mcData.blocksByName[name]?.id;
            if (id !== undefined) movements.blocksToAvoid.add(id);
        }
        return disableDiagonalMoves(movements);
    }

    async moveTo(position, generation, deadline) {
        this.checkActive(generation);
        const bot = this.bot;
        const goal = new goals.GoalBlock(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
        let timer;
        const guard = new Promise((_, reject) => {
            timer = setInterval(() => {
                if (bot.isInCombat?.()) {
                    reject(new Error('Combat en cours : priorite a la survie'));
                } else if (generation !== this.generation || !bot.entity || Date.now() > deadline) {
                    reject(new Error('Retour interrompu ou delai depasse'));
                } else if (this.threatNearCurrent(bot.entity.position) || this.hostileNear(position, 8)) {
                    reject(new Error('Mob hostile sur le trajet'));
                }
            }, 250);
        });
        try {
            await Promise.race([bot.pathfinder.goto(goal), guard]);
        } catch (error) {
            if (!bot.isInCombat?.()) bot.pathfinder.stop();
            throw error;
        } finally {
            clearInterval(timer);
        }
        this.checkActive(generation);
        if (bot.entity.position.distanceTo(new Vec3(goal.x+0.5,goal.y,goal.z+0.5))>1.25)
            throw new Error('Trajet termine sans atteindre la marche');
    }

    async findWaypoint(deathPosition) {
        const current = this.bot.entity.position;
        for (const [key,value] of this.visitedWaypoints) if (value.expires<Date.now()) this.visitedWaypoints.delete(key);
        const candidates = [];
        for (let dx=-12;dx<=12;dx++) for (let dz=-12;dz<=12;dz++) {
            if (Math.hypot(dx,dz)<2 || Math.hypot(dx,dz)>14) continue;
            for (let dy=-12;dy<=12;dy++) {
                const target=current.floored().offset(dx,dy,dz);
                if (!this.standable(target.x,target.y,target.z) || this.hostileNear(target,8)) continue;
                if ([...this.visitedWaypoints.values()].some(value=>value.position.distanceTo(target)<2)) continue;
                candidates.push(target);
            }
        }
        candidates.sort((a,b)=>a.distanceTo(deathPosition)-b.distanceTo(deathPosition));
        for (const target of candidates.slice(0,32)) {
            const goal=new goals.GoalBlock(Math.floor(target.x),Math.floor(target.y),Math.floor(target.z));
            const route=await planCompletePath(this.bot,goal,500);
            if (route.status==='success' && route.path?.length &&
                !require('./MobSafety').threatNearPath(this.bot,route.path)) return target;
        }
        return null;
    }

    async stepOffLeaf(deathPosition) {
        const bot=this.bot;
        if (!bot.lookAt || !bot.waitForTicks || !bot.setControlState) return false;
        const feet=bot.entity.position.floored();
        const floor=bot.blockAt(feet.offset(0,-1,0));
        // This fallback is for crossing a canopy, not for wandering on solid ground
        // after the pathfinder has found no route down from a plateau.
        if (!floor?.name.endsWith('_leaves') || floor.boundingBox !== 'block') return false;
        const options=OFFSETS.map(([x,z])=>feet.offset(x,0,z)).filter(p=>
            this.standable(p.x,p.y,p.z) && !this.hostileNear(p,8) &&
            ((bot.blockAt(p.offset(0,-1,0))?.name.endsWith('_log') && bot.blockAt(p.offset(0,-2,0))?.boundingBox==='block') ||
            ![...this.visitedWaypoints.values()].some(v=>v.expires>Date.now() && v.position.distanceTo(p)<0.8)));
        const trunk=p=>bot.blockAt(p.offset(0,-1,0))?.name.endsWith('_log') &&
            bot.blockAt(p.offset(0,-2,0))?.boundingBox==='block';
        options.sort((a,b)=>Number(trunk(b))-Number(trunk(a)) || a.distanceTo(deathPosition)-b.distanceTo(deathPosition));
        const next=options[0];
        if (!next) return false;
        const start=bot.entity.position.clone();
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        const center=next.offset(0.5,0,0.5);
        console.log(`[DeathRecovery] Marche prudente sur les feuilles de ${feet} vers ${next}.`);
        try {
            await bot.lookAt(center.offset(0,1.4,0),true);
            bot.setControlState('sneak',true);
            for (let tick=0;tick<30;tick++) {
                if (!this.standable(next.x,next.y,next.z) || this.hostileNear(next,8)) break;
                if (Math.hypot(bot.entity.position.x-center.x,bot.entity.position.z-center.z)<0.2) break;
                bot.setControlState('forward',true);
                await bot.waitForTicks(1);
            }
        } finally {bot.clearControlStates();}
        if (bot.entity.position.distanceTo(start)<0.4) return false;
        this.visitedWaypoints.set(feet.toString(),{position:feet,expires:Date.now()+120000});
        console.log(`[DeathRecovery] Position apres la marche : ${bot.entity.position}.`);
        return true;
    }

    async openTreeExit(deathPosition, generation) {
        const bot = this.bot;
        const feet = bot.entity.position.floored();
        if (!bot.blockAt(feet.offset(0, -1, 0))?.name.endsWith('_leaves')) return false;
        const { threatNearPoint } = require('./MobSafety');
        const options = [];
        for (const [x, z] of OFFSETS) for (const dy of [-1, 0]) {
            const point = feet.offset(x, dy, z);
            const floor = bot.blockAt(point.offset(0, -1, 0));
            const body = bot.blockAt(point), head = bot.blockAt(point.offset(0, 1, 0));
            if (!floor || floor.boundingBox !== 'block' || DANGEROUS_BLOCKS.test(floor.name) ||
                !body || !head || [body, head].some(b => b.boundingBox !== 'empty' && !/_(leaves|log)$/.test(b.name)) ||
                [body, head].some(b => DANGEROUS_BLOCKS.test(b.name)) ||
                [...this.visitedWaypoints.values()].some(v => v.expires > Date.now() && v.position.distanceTo(point) < 0.8)) continue;
            const clear = [body, head].filter(b => /_(leaves|log)$/.test(b.name));
            if (!clear.length || clear.some(b => !bot.canDigBlock(b))) continue;
            if (threatNearPoint(bot, point, 3, clear.map(b => b.position))) continue;
            if (clear.some(b => OFFSETS.some(([dx, dz]) => {
                const neighbor = bot.blockAt(b.position.offset(dx, 0, dz));
                return !neighbor || /water|lava|sand|gravel/.test(neighbor.name);
            }))) continue;
            options.push({ point, clear, score: dy * 10 + (floor.name.endsWith('_log') ? -20 : 0) + point.distanceTo(deathPosition) * 0.01 });
        }
        options.sort((a, b) => a.score - b.score);
        for (const option of options) {
            this.checkActive(generation);
            bot.pathfinder.setGoal(null);
            bot.clearControlStates?.();
            for (const block of option.clear) {
                this.checkActive(generation);
                await require('./Pathing').withTimeout(bot, bot.dig(block), 5000, 'Feuillage bloque');
            }
            if (!this.standable(option.point.x, option.point.y, option.point.z)) continue;
            const walking = require('./Pathing').existingPassageMovements(bot);
            const goal = new goals.GoalBlock(option.point.x, option.point.y, option.point.z);
            const route = await planCompletePath(bot, goal, 800, walking);
            if (route.status !== 'success' || threatNearPoint(bot, option.point, 3)) continue;
            bot.pathfinder.setMovements(walking);
            console.log(`[DeathRecovery] Sortie du feuillage vers une marche soutenue : ${option.point}.`);
            await this.moveTo(option.point, generation, Date.now() + 10000);
            this.visitedWaypoints.set(feet.toString(), { position: feet, expires: Date.now() + 120000 });
            return true;
        }
        return false;
    }

    async run() {
        if (!this.pending || !this.ready || this.running || Date.now()<this.retryAt) return;
        this.running = true;
        const generation = this.generation;
        const death = this.pending;
        const bot = this.bot;
        const originalMovements = bot.pathfinder.movements;
        const deadline = Date.now() + 120000;
        let completed = false;
        try {
            if (bot.game.dimension !== death.dimension) {
                throw new Error('Mort dans une autre dimension : portail necessaire');
            }
            bot.pathfinder.setMovements(this.safeMovements());
            console.log(`[DeathRecovery] Retour prudent vers ${death.position}.`);

            for (let steps = 0; steps < 40; steps++) {
                this.checkActive(generation);
                const current = bot.entity.position;
                const floor = bot.blockAt(current.floored().offset(0,-1,0));
                if (/_(leaves|log)$/.test(floor?.name || '')) {
                    const descent = new (require('./MushroomFood'))(bot,null);
                    if (await descent.lowerPillar(current.offset(0,-4,0))) continue;
                    if (floor.name.endsWith('_leaves') && await this.openTreeExit(death.position, generation)) continue;
                }
                const distance = current.distanceTo(death.position);
                if (Date.now() > deadline) throw new Error('Delai de retour depasse');

                if (distance < 3 && this.stableGround(Math.floor(current.x),
                    Math.floor(current.y), Math.floor(current.z)) && !this.hostileNear(current, 8)) {
                    console.log('[DeathRecovery] Zone de mort atteinte.');
                    // Ramasser les objets visibles, plutot que s'arreter a trois blocs.
                    for (const item of Object.values(bot.entities).filter(e=>e.name==='item' && e.position?.distanceTo(death.position)<6)) {
                        const pickup = this.safeCellNear(item.position,1,1);
                        if (pickup && !this.hostileNear(pickup,8)) await this.moveTo(pickup,generation,deadline);
                    }
                    completed = true;
                    return;
                }

                // Inspect the death area only once its chunk is loaded.
                const targetLoaded = this.block(Math.floor(death.position.x),
                    Math.floor(death.position.y), Math.floor(death.position.z));
                let target;
                if (targetLoaded && distance <= 24) {
                    target = this.safeCellNear(death.position, 3, 2, death.position);
                    if (!target) target = await this.findWaypoint(death.position);
                    if (!target) throw new Error('Aucun sol sur et accessible pres de la mort');
                } else {
                    const fraction = Math.min(12 / distance, 1);
                    const waypoint = current.plus(death.position.minus(current).scaled(fraction));
                    waypoint.y = current.y;
                    target = this.safeCellNear(waypoint, 4, 8);
                    if (!target) target = await this.findWaypoint(death.position);
                    if (!target) throw new Error('Terrain inconnu ou dangereux vers la mort');
                }

                if (this.threatNearCurrent(current)) {
                    throw new Error('Mob proche : retour suspendu pour laisser la survie agir');
                }
                if (this.hostileNear(target, 8)) {
                    // A straight waypoint can approach a mob while the bot itself is safe.
                    // Try a path-checked detour before suspending the whole recovery.
                    target = await this.findWaypoint(death.position);
                    if (!target || this.hostileNear(target, 8))
                        throw new Error('Mob proche : retour suspendu pour laisser la survie agir');
                }
                if ([...this.visitedWaypoints.values()].some(value=>value.expires>Date.now() && value.position.distanceTo(target)<2)) {
                    target=await this.findWaypoint(death.position);
                    if (!target) throw new Error('Aucun nouveau passage accessible');
                }
                if (target.distanceTo(current) < 1.5) {
                    target = await this.findWaypoint(death.position);
                    if (!target) throw new Error('Impossible de progresser vers la mort');
                }
                console.log(`[DeathRecovery] Etape sure vers ${target}.`);
                try {
                    await this.moveTo(target, generation, deadline);
                    this.visitedWaypoints.set(target.toString(),{position:target,expires:Date.now()+120000});
                } catch (error) {
                    if (error.message === 'Mob hostile sur le trajet') {
                        throw error;
                    }
                    this.checkActive(generation);
                    this.visitedWaypoints.set(target.toString(),{position:target,expires:Date.now()+120000});
                    const alternative = await this.findWaypoint(death.position);
                    if (!alternative) throw error;
                    console.log(`[DeathRecovery] Detour accessible vers ${alternative}.`);
                    await this.moveTo(alternative,generation,deadline);
                    this.visitedWaypoints.set(alternative.toString(),{position:alternative,expires:Date.now()+120000});
                }
            }
            throw new Error('Nombre maximal d etapes atteint');
        } catch (error) {
            if (error.code === 'ACTION_INTERRUPTED') return;
            if (generation !== this.generation) return;
            if (bot.isInCombat?.()) {
                this.retryAt = Date.now() + 10000;
                console.log('[DeathRecovery] Combat : mouvements laisses a la survie.');
                return;
            }
            try {
                if (await this.openTreeExit(death.position, generation)) {
                    this.retryAt = Date.now() + 500;
                    return;
                }
            } catch (exitError) {
                console.log(`[DeathRecovery] Sortie du feuillage interrompue : ${exitError.message}`);
                if (generation !== this.generation || bot.isInCombat?.()) return;
            }
            if (generation===this.generation && await this.stepOffLeaf(death.position)) {
                this.retryAt=Date.now()+500;
                return;
            }
            const feet=bot.entity.position.floored();
                const cells=[[0,0],...OFFSETS].map(([x,z])=>[x,z,[-2,-1,0,1].map(y=>bot.blockAt(feet.offset(x,y,z))?.name)]);
            console.log(`[DeathRecovery] Diagnostic ${bot.entity.position}: ${JSON.stringify(cells)}`);
            console.log(`[DeathRecovery] Retour suspendu : ${error.message}. Nouvel essai dans 10 s.`);
            this.retryAt = Date.now()+10000;
            if (Date.now()-(this.lastNotice||0)>60000) {
                this.lastNotice=Date.now();
                bot.chat?.(`[SpeedBot] Recuperation du stuff en attente : ${error.message}. Je reessaie dans 10 s.`);
            }
        } finally {
            const lease = bot.actions?.context.getStore();
            if (generation === this.generation && (!lease || bot.actions.valid(lease))) {
                if (!bot.isInCombat?.()) {
                    bot.pathfinder.setMovements(originalMovements);
                    bot.clearControlStates?.();
                }
                if (completed) {this.pending = null;this.ready = false;this.save();}
            }
            this.running = false;
        }
    }
}

module.exports = DeathRecovery;
