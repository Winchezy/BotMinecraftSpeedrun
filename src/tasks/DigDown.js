const Task = require('../lib/Task');
const Vec3 = require('vec3').Vec3;

// Cerveau neuronal partagé pour les décisions de creusage
let movementBrain = null;
try {
    const { getInstance } = require('../lib/MovementBrain');
    movementBrain = getInstance();
} catch (e) { /* Pas de cerveau, on utilise les règles */ }

class DigDown extends Task {
    constructor(bot, targetY, targetOreNames = []) {
        super(bot);
        this.name           = 'DigDown';
        this.targetY        = targetY;
        this.targetOreNames = targetOreNames; // ex: ['iron_ore', 'deepslate_iron_ore']
        this.mcData         = require('minecraft-data')(bot.version);

        // Suivi de blocage : si on reste dans la même direction sans progresser
        this._lastPos             = null;
        this._stuckTicks          = 0;
        this._lastCardinal        = null;
        this._rotations           = 0;
        this._tunnelFailures      = 0; // échecs TUNNEL consécutifs
        this._forceStaircaseTicks = 0; // ticks restants à forcer STAIRCASE
        this._bridgedBlocks       = new Set(); // ponts posés : interdits au creusage
    }

    _posKey(v) { return `${v.x},${v.y},${v.z}`; }

    // Trouve le minerai cible le plus proche dans le rayon de détection
    _findTargetOre() {
        if (this.targetOreNames.length === 0) return null;

        let best = null;
        let bestDist = Infinity;

        for (const name of this.targetOreNames) {
            const blockType = this.mcData.blocksByName[name];
            if (!blockType) continue;
            const block = this.bot.findBlock({ matching: blockType.id, maxDistance: 32 });
            if (!block) continue;
            const dist = this.bot.entity.position.distanceTo(block.position);
            if (dist < bestDist) {
                bestDist = dist;
                best = block;
            }
        }

        return best;
    }

    // Calcule le yaw (mineflayer) vers une position, arrondi au cardinal le plus proche
    _yawToward(targetPos) {
        const p = this.bot.entity.position;
        const yaw = Math.atan2(p.x - targetPos.x, p.z - targetPos.z);
        return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    }

    // Calcule la direction et le mode de creusage pour ce tick
    _computeDirection() {
        const pos = this.bot.entity.position;
        const ore = this._findTargetOre();

        // TUNNEL forcé en STAIRCASE après trop d'échecs consécutifs
        if (this._forceStaircaseTicks > 0) {
            this._forceStaircaseTicks--;
            const cardinal = Math.round(this.bot.entity.yaw / (Math.PI / 2)) * (Math.PI / 2);
            return { cardinal, mode: 'STAIRCASE', ore };
        }

        if (ore) {
            const cardinal = this._yawToward(ore.position);
            const dy  = ore.position.y - pos.y;
            const dxz = Math.sqrt((ore.position.x - pos.x) ** 2 + (ore.position.z - pos.z) ** 2);
            const mode = (Math.abs(dy) <= 3 && dxz >= 2) ? 'TUNNEL' : 'STAIRCASE';
            return { cardinal, mode, ore };
        }

        // Pas de minerai visible : escalier dans la direction actuelle du bot
        const cardinal = Math.round(this.bot.entity.yaw / (Math.PI / 2)) * (Math.PI / 2);
        return { cardinal, mode: 'STAIRCASE', ore: null };
    }

    async run() {
        const pos    = this.bot.entity.position;
        const botPos = pos.floored();

        // ── Conditions de fin ────────────────────────────────────────────────
        if (pos.y <= this.targetY) {
            console.log(`[DigDown] Niveau cible atteint (Y=${this.targetY})`);
            if (movementBrain) movementBrain.saveAll();
            this.complete();
            return;
        }

        const nearOre = this._findTargetOre();
        if (nearOre && pos.distanceTo(nearOre.position) <= 4) {
            console.log(`[DigDown] Minerai à portée : ${nearOre.name} — arrêt.`);
            if (movementBrain) movementBrain.saveAll();
            this.complete();
            return;
        }

        // ── Détection de blocage ─────────────────────────────────────────────
        if (this._lastPos) {
            const moved = pos.distanceTo(this._lastPos);
            if (moved < 0.05) {
                this._stuckTicks++;
            } else {
                this._stuckTicks = 0;
                this._rotations  = 0;
            }
        }
        this._lastPos = pos.clone();

        // ── Direction ce tick ────────────────────────────────────────────────
        let { cardinal, mode, ore } = this._computeDirection();

        // Si bloqué depuis trop longtemps, tourner de 90°
        if (this._stuckTicks > 20) {
            this._rotations++;
            this._stuckTicks = 0;
            cardinal = cardinal - (Math.PI / 2) * (this._rotations % 4 || 1);
            mode     = 'STAIRCASE';
            console.log(`[DigDown] Bloqué, rotation → ${(cardinal * 180 / Math.PI).toFixed(0)}°`);
        }

        if (cardinal !== this._lastCardinal) {
            const target = ore ? ore.name : 'défaut';
            console.log(`[DigDown] Mode ${mode} vers ${target} → ${(cardinal * 180 / Math.PI).toFixed(0)}°`);
            this._lastCardinal = cardinal;
        }

        const dx      = -Math.sin(cardinal);
        const dz      = -Math.cos(cardinal);
        const forward = new Vec3(Math.round(dx), 0, Math.round(dz));

        // ── Exécution ────────────────────────────────────────────────────────
        if (mode === 'TUNNEL') {
            await this._runTunnel();
        } else {
            await this._runStaircase(cardinal, forward, botPos);
        }
    }

    async _runTunnel() {
        const { goals } = require('mineflayer-pathfinder');
        const ore = this._findTargetOre();
        if (!ore) return; // plus de minerai visible, prochain tick repassera en STAIRCASE

        console.log(`[DigDown] Tunnel: pathfinding vers ${ore.name} à ${ore.position}`);
        try {
            const gotoPromise = this.bot.pathfinder.goto(
                new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2)
            );
            // Éviter un unhandledRejection quand le race expire avant le goto
            gotoPromise.catch(() => {});
            await Promise.race([
                gotoPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            console.log(`[DigDown] Tunnel: minerai atteint, arrêt.`);
            this._tunnelFailures = 0;
            if (movementBrain) movementBrain.saveAll();
            this.complete();
        } catch (e) {
            // CRITIQUE : annuler le goto resté actif, sinon le pathfinder garde son
            // goal et avorte tous les bot.dig() suivants ("Digging aborted")
            this.bot.pathfinder.setGoal(null);
            this._tunnelFailures++;
            if (this._tunnelFailures >= 3) {
                this._forceStaircaseTicks = 30;
                this._tunnelFailures = 0;
                console.log(`[DigDown] Tunnel échoué 3x → STAIRCASE forcé pour 30 ticks.`);
            } else {
                console.log(`[DigDown] Tunnel pathfind échoué (${e.message}), tentative ${this._tunnelFailures}/3.`);
                this._lastCardinal = null;
            }
        }
    }

    // Profondeur de chute si on avance : nb de blocs d'air sous la case d'arrivée.
    // Retourne Infinity si > 3, chunk non chargé, ou liquide (danger).
    _dropDepthAhead(targetFloor) {
        for (let d = 0; d <= 3; d++) {
            const blk = this.bot.blockAt(targetFloor.offset(0, -d, 0));
            if (!blk) return Infinity;
            if (blk.name.includes('lava') || blk.name.includes('water')) return Infinity;
            if (blk.boundingBox === 'block') return d;
        }
        return Infinity;
    }

    // Pose un bloc devant (au niveau du sol) pour combler un vide
    async _bridgeGap(botPos, forward) {
        const placeable = this.bot.inventory.items().find(i =>
            ['cobblestone', 'dirt', 'stone', 'andesite', 'diorite', 'granite',
             'netherrack', 'cobbled_deepslate', 'deepslate'].includes(i.name)
        );
        if (!placeable) return false;
        const refBlock = this.bot.blockAt(botPos.offset(0, -1, 0));
        if (!refBlock || refBlock.boundingBox !== 'block') return false;
        try {
            await this.bot.equip(placeable, 'hand');
            await this.bot.placeBlock(refBlock, new Vec3(forward.x, 0, forward.z));
            // Mémoriser le pont pour ne JAMAIS le re-creuser (sinon boucle pose/creuse)
            this._bridgedBlocks.add(this._posKey(botPos.offset(forward.x, -1, forward.z)));
            console.log('[DigDown] Pont posé au-dessus du vide.');
            return true;
        } catch (e) {
            console.log(`[DigDown] Échec du pont : ${e.message}`);
            return false;
        }
    }

    // Équipe la meilleure pioche disponible (fer > pierre > bois...)
    async _equipBestPickaxe() {
        const order = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
        for (const name of order) {
            const item = this.bot.inventory.items().find(i => i.name === name);
            if (item) {
                if (!this.bot.heldItem || this.bot.heldItem.name !== name) {
                    await this.bot.equip(item, 'hand');
                }
                return item;
            }
        }
        return null;
    }

    async _runStaircase(cardinal, forward, botPos) {
        // Équiper AVANT la décision neuronale, sinon les dig neuronaux se font à la main
        const pickaxe = await this._equipBestPickaxe();
        if (!pickaxe) { this.fail('No pickaxe'); return; }

        // Utiliser la position Y réelle (pas floored) pour trouver le vrai niveau de la tête
        const realY        = this.bot.entity.position.y;
        const feetY        = Math.floor(realY);
        const headY        = Math.floor(realY + 1.6); // niveau réel du bloc tête

        const targetHead   = new Vec3(botPos.x + forward.x, headY,     botPos.z + forward.z);
        const targetBody   = new Vec3(botPos.x + forward.x, feetY,     botPos.z + forward.z);
        const targetFloor  = new Vec3(botPos.x + forward.x, feetY - 1, botPos.z + forward.z);
        const targetFloor2 = new Vec3(botPos.x + forward.x, feetY - 2, botPos.z + forward.z);

        // ── Décision neuronale ────────────────────────────────────────────────
        if (movementBrain) {
            const neuralDecision = movementBrain.decideDigAction(
                this.bot, this.targetY, forward, this._stuckTicks
            );
            if (neuralDecision) {
                const { action } = neuralDecision;
                const blkHead  = this.bot.blockAt(targetHead);
                const blkBody  = this.bot.blockAt(targetBody);
                const blkFloor = this.bot.blockAt(targetFloor);

                if (action === 'DIG_HEAD' && blkHead && blkHead.boundingBox === 'block') {
                    await this.bot.dig(blkHead); return;
                } else if (action === 'DIG_BODY' && blkBody && blkBody.boundingBox === 'block') {
                    await this.bot.dig(blkBody); return;
                } else if (action === 'DIG_FLOOR' && blkFloor && blkFloor.boundingBox === 'block'
                           && !this._bridgedBlocks.has(this._posKey(targetFloor))) {
                    await this.bot.dig(blkFloor); return;
                } else if (action === 'DIG_UNDER') {
                    const blkUnder = this.bot.blockAt(botPos.offset(0, -1, 0));
                    // Jamais creuser sous ses pieds si c'est un pont ou si le vide
                    // en dessous est profond (chute mortelle)
                    const safeUnder = blkUnder && blkUnder.boundingBox === 'block'
                        && !this._bridgedBlocks.has(this._posKey(botPos.offset(0, -1, 0)))
                        && this._dropDepthAhead(botPos.offset(0, -2, 0)) <= 1;
                    if (safeUnder) {
                        await this.bot.dig(blkUnder); return;
                    }
                } else if (action === 'MOVE_FORWARD') {
                    // Valider que la voie est libre ET qu'il n'y a pas de grand vide devant
                    const pathClear = (!blkHead || blkHead.boundingBox !== 'block')
                                   && (!blkBody || blkBody.boundingBox !== 'block')
                                   && this._dropDepthAhead(targetFloor) <= 2;
                    if (pathClear) {
                        const walkTarget = targetBody.offset(0.5, 0, 0.5);
                        await this.bot.lookAt(walkTarget);
                        try {
                            this.bot.setControlState('forward', true);
                            let s = 0;
                            while (this.bot.entity.position.distanceSquared(walkTarget) > 0.2 && s < 40) {
                                await this.bot.waitForTicks(1); s++;
                            }
                        } finally {
                            this.bot.setControlState('forward', false);
                        }
                        return;
                    }
                    // Voie bloquée → les règles prennent le relais (creuser)
                }
                // Si l'action neuronale ne s'applique pas → les règles prennent la relève
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        await this.bot.look(cardinal, 0);

        // 1. Dégager la tête
        const blkHead = this.bot.blockAt(targetHead);
        if (blkHead && blkHead.boundingBox === 'block') {
            await this.bot.dig(blkHead);
            if (movementBrain) movementBrain.recordDigSuccess(this.bot, 'DIG_HEAD', this.targetY, forward, this._stuckTicks, this.bot.entity.position.y);
            return;
        }

        // 2. Dégager le corps
        const blkBody = this.bot.blockAt(targetBody);
        if (blkBody && blkBody.boundingBox === 'block') {
            await this.bot.dig(blkBody);
            if (movementBrain) movementBrain.recordDigSuccess(this.bot, 'DIG_BODY', this.targetY, forward, this._stuckTicks, this.bot.entity.position.y);
            return;
        }

        // 2b. Bloc au-dessus du bot (cas rare)
        const currentHead = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0).floored());
        if (currentHead && currentHead.boundingBox === 'block') {
            await this.bot.dig(currentHead);
            return;
        }

        // 3. Dégager le sol avant (descente en escalier) — sauf si c'est un pont :
        // dans ce cas on marche dessus (étape 4) au lieu de le re-creuser
        const blkFloor = this.bot.blockAt(targetFloor);
        if (blkFloor && blkFloor.boundingBox === 'block'
            && !this._bridgedBlocks.has(this._posKey(targetFloor))) {
            const blkBelowTarget = this.bot.blockAt(targetFloor2);

            if (!blkBelowTarget || blkBelowTarget.boundingBox !== 'block') {
                if (blkBelowTarget && (blkBelowTarget.name.includes('lava') || blkBelowTarget.name.includes('water'))) {
                    console.log('[DigDown] Liquide détecté sous le chemin, arrêt.');
                    this.complete();
                    return;
                }

                // Vide : tenter de combler après avoir creusé
                console.log('[DigDown] Vide détecté sous le chemin, tentative de pont...');
            }

            await this.bot.dig(blkFloor);
            if (movementBrain) movementBrain.recordDigSuccess(this.bot, 'DIG_FLOOR', this.targetY, forward, this._stuckTicks, this.bot.entity.position.y);

            await this.bot.waitForTicks(2);
            const freshBlkBelow = this.bot.blockAt(targetFloor2);
            if (!freshBlkBelow || freshBlkBelow.boundingBox !== 'block') {
                const placeable = this.bot.inventory.items().find(i =>
                    i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
                    i.name === 'andesite'    || i.name === 'diorite' || i.name === 'granite'
                );
                if (placeable) {
                    try {
                        await this.bot.equip(placeable, 'hand');
                        const refBlock = this.bot.blockAt(botPos.offset(0, -2, 0));
                        if (refBlock && refBlock.boundingBox === 'block') {
                            await this.bot.placeBlock(refBlock, forward);
                            console.log('[DigDown] Pont posé.');
                        }
                    } catch (e) {
                        console.log(`[DigDown] Échec du pont : ${e.message}`);
                    }
                }
            }
            return;
        }

        // 4. Avancer — mais jamais au-dessus d'un grand vide (chute mortelle)
        const dropDepth = this._dropDepthAhead(targetFloor);
        if (dropDepth > 2) {
            console.log(`[DigDown] Vide/danger devant (profondeur ${dropDepth === Infinity ? '>3' : dropDepth}) — pont au lieu d'avancer.`);
            const bridged = await this._bridgeGap(botPos, forward);
            if (!bridged) {
                // Rien à poser : forcer une rotation au prochain tick
                this._stuckTicks = 25;
            }
            return;
        }

        const walkTarget = targetBody.offset(0.5, 0, 0.5);
        if (this.bot.entity.position.distanceSquared(walkTarget) > 0.2) {
            await this.bot.lookAt(walkTarget);
            try {
                this.bot.setControlState('forward', true);
                let s = 0;
                while (this.bot.entity.position.distanceSquared(walkTarget) > 0.2 && s < 40) {
                    await this.bot.waitForTicks(1); s++;
                }
            } finally {
                this.bot.setControlState('forward', false);
            }
            if (movementBrain) movementBrain.recordDigSuccess(this.bot, 'MOVE_FORWARD', this.targetY, forward, this._stuckTicks, this.bot.entity.position.y);
        }
    }
}

module.exports = DigDown;
