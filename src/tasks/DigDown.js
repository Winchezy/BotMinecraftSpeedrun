const Task = require('../lib/Task');
const Vec3 = require('vec3').Vec3;
const { routeThreats } = require('../lib/MobSafety');
const { threatNearPath, threatNearPoint } = require('../lib/MobSafety');
const { goals } = require('mineflayer-pathfinder');
const { existingPassageMovements, planCompletePath, withTimeout } = require('../lib/Pathing');

// Descente en escalier 1x1, robuste :
// - direction VERROUILLEE au 1er tick (evite la derive erratique quand Survival
//   fait pivoter le bot),
// - dig/placeBlock bornes dans le temps (jamais de gel),
// - detection des liquides (on ne creuse pas dans l'eau/lave, on contourne),
// - vrai "bridging" des vides/grottes (pose reelle d'un bloc).
class DigDown extends Task {
    constructor(bot, targetY, oreName = targetY >= 0 ? 'iron_ore' : 'diamond_ore') {
        super(bot);
        this.name = 'DigDown';
        this.targetY = targetY;
        this.oreName = oreName;
        this.caveMoves = 0;
        this.visitedCaves = new Set();
        this.mcData = require('minecraft-data')(bot.version);
        this.dir = null;       // direction de l'escalier, verrouillee
        this.turns = 0;        // nb de contournements consecutifs
        this.lastY = null;     // suivi de progression verticale
        this.noProgress = 0;   // ticks sans descente
        this.digFails = 0;     // aborts de minage consecutifs (eau/Survival)
    }

    isLiquid(b) { return !!b && (b.name.includes('water') || b.name.includes('lava')); }
    isSolid(b) { return !!b && b.boundingBox === 'block'; }

    // dig avec timeout : ne gele jamais, retourne true si casse (ou rien a casser).
    async safeDig(block) {
        if (!this.isSolid(block)) return true;
        if (block.name === 'bedrock' || block.name.includes('lava')) return false;
        const threat = threatNearPoint(this.bot,this.bot.entity.position,0,[block.position]);
        if (threat) {
            console.log(`[DigDown] Bloc ${block.position} refuse : acces possible pour ${threat.name}.`);
            this.fail('Mobs sur le trajet apres ouverture du bloc');
            return false;
        }
        try {
            await withTimeout(this.bot,this.bot.dig(block),8000,'dig timeout');
            this.digFails = 0; // succes -> reset
            return true;
        } catch (e) {
            try { this.bot.stopDigging(); } catch (_) { }
            this.digFails = (this.digFails || 0) + 1;
            console.log(`[DigDown] dig interrompu (${this.digFails}): ${e.message}`);
            // Aborts en continu (eau/Survival qui annule le dig) : on abandonne pour que
            // le disjoncteur de l'Agent relocalise sur un sol sec, au lieu de boucler.
            if (this.digFails >= 12) {
                this.fail("Minage bloque en continu (eau/Survival) - relocalisation requise");
            }
            return false;
        }
    }

    async run() {
        // Ne jamais calculer une nouvelle marche pendant une chute ou un saut.
        // floored() donnerait alors une hauteur intermediaire, pas celle du palier.
        if (this.bot.entity.onGround === false) return;
        const pos = this.bot.entity.position;
        if (this.bot.inventory?.items) {
            const picks = this.bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'));
            const remaining = picks.reduce((n, i) => n + (i.maxDurability == null ? Infinity :
                Math.max(0, i.maxDurability - (i.durabilityUsed || 0))), 0);
            const reserve = Math.max(32, Math.ceil(Math.max(0, 70 - pos.y) * 2) + 16);
            if (remaining < reserve) {
                this.fail('Reserve de pioche pour la remontee');
                return;
            }
        }
        if (threatNearPoint(this.bot,pos)) {
            this.fail('Mobs sur le trajet de descente');
            return;
        }
        if (pos.y <= this.targetY) {
            console.log(`[DigDown] Profondeur atteinte (Y=${Math.floor(pos.y)}).`);
            this.complete();
            return;
        }

        // Watchdog de progression : si on ne descend plus du tout (coince dans
        // l'eau/une grotte), on abandonne pour laisser l'Agent relocaliser ailleurs
        // au lieu de monopoliser le bot indefiniment.
        const curY = Math.floor(pos.y);
        if (this.lastY === null || curY < this.lastY) {
            this.lastY = curY;
            this.noProgress = 0;
        } else if (++this.noProgress > 60) {
            console.log("[DigDown] Aucune progression -> abandon (relocalisation requise).");
            this.fail("Descente bloquee");
            return;
        }

        // Seul le minerai demande par l'etape peut interrompre cette recherche.
        const oreIds = [
            this.mcData.blocksByName[this.oreName]?.id,
            this.mcData.blocksByName[`deepslate_${this.oreName}`]?.id
        ].filter(x => x != null);
        const ore = this.bot.findBlock({ matching: oreIds, maxDistance: 4 });
        if (ore && !threatNearPoint(this.bot, ore.position, 3)) {
            console.log(`[DigDown] ${this.oreName} repere a ${ore.position} !`);
            this.bot.caveMiningTarget = { oreName: this.oreName, position: ore.position.clone() };
            this.complete();
            return;
        }
        if (this.caveMoves < 3 && await this.followCave(oreIds)) return;

        // Pioche obligatoire.
        const pickaxe = this.bot.inventory.items().find(i => i.name.includes('pickaxe'));
        if (!pickaxe) { this.fail("No pickaxe"); return; }
        await this.bot.equip(pickaxe, 'hand');

        // Verrouiller la direction de l'escalier au 1er passage.
        if (!this.dir) this.dir = this.cardinalFromYaw(this.bot.entity.yaw);
        const fwd = this.dir;

        const botPos = this.bot.entity.position.floored();
        const head = botPos.offset(fwd.x, 1, fwd.z);
        const body = botPos.offset(fwd.x, 0, fwd.z);
        const floor = botPos.offset(fwd.x, -1, fwd.z);    // on descendra dedans
        const landing = botPos.offset(fwd.x, -2, fwd.z);  // doit etre solide pour s'y tenir

        const bHead = this.bot.blockAt(head);
        const bBody = this.bot.blockAt(body);
        const bFloor = this.bot.blockAt(floor);

        // Securite liquides dans le chemin -> contourner (ne pas se battre avec l'eau).
        if (this.isLiquid(bHead) || this.isLiquid(bBody) || this.isLiquid(bFloor)) {
            console.log("[DigDown] Liquide dans le chemin -> contournement.");
            if (!(await this.turn())) this.fail("Bloque par un liquide");
            return;
        }

        // Degager tete puis corps (le chemin devant).
        if (this.isSolid(bHead)) { await this.safeDig(bHead); return; }
        if (this.isSolid(bBody)) { await this.safeDig(bBody); return; }

        // Degager le sol devant (la marche). Apres ca, `landing` est expose.
        if (this.isSolid(bFloor)) {
            if (!(await this.safeDig(bFloor))) { if (!(await this.turn())) this.fail("Sol indestructible"); }
            return;
        }

        // Ici, head/body/floor sont vides. On verifie le palier sous la marche.
        const bLanding = this.bot.blockAt(landing);
        if (this.isLiquid(bLanding)) {
            console.log("[DigDown] Liquide sous la marche -> contournement.");
            if (!(await this.turn())) this.fail("Liquide sous la marche");
            return;
        }
        if (!this.isSolid(bLanding)) {
            // Vide/grotte : on comble pour ne pas tomber.
            console.log("[DigDown] Vide sous la marche -> pose d'un bloc.");
            if (!(await this.bridge(landing))) {
                if (!(await this.turn())) this.fail("Vide infranchissable");
            }
            return;
        }

        // Tout est sur : on avance d'une marche (descente d'1 bloc).
        this.turns = 0;
        await this.stepInto(floor);
    }

    cardinalFromYaw(yaw) {
        const card = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
        let v = new Vec3(Math.round(-Math.sin(card)), 0, Math.round(-Math.cos(card)));
        if (v.x === 0 && v.z === 0) v = new Vec3(1, 0, 0);
        return v;
    }

    // Pose un bloc a `target` (un vide) en s'appuyant sur un voisin solide.
    async bridge(target) {
        const placeable = this.bot.inventory.items().find(i =>
            i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' ||
            i.name === 'andesite' || i.name === 'diorite' || i.name === 'granite' ||
            i.name === 'cobbled_deepslate' || i.name === 'tuff' || i.name === 'netherrack');
        if (!placeable) { console.log("[DigDown] Rien pour combler."); return false; }

        const dirs = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
        for (const d of dirs) {
            const ref = this.bot.blockAt(target.plus(d));
            if (!this.isSolid(ref)) continue;
            const face = new Vec3(-d.x, -d.y, -d.z); // face exposee de `ref` vers `target`
            try {
                await this.bot.equip(placeable, 'hand');
                await this.bot.lookAt(target.offset(0.5, 0.5, 0.5), false);
                await Promise.race([
                    this.bot.placeBlock(ref, face),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('place timeout')), 6000))
                ]);
                console.log("[DigDown] Vide comble.");
                return true;
            } catch (e) {
                // essayer le voisin suivant
            }
        }
        return false;
    }

    async followCave(oreIds) {
        const origin = this.bot.entity.position;
        const detected = this.bot.findBlocks({ matching: oreIds, maxDistance: 32, count: 12 })
            .filter(p => !threatNearPoint(this.bot, p, 3));
        const floors = this.bot.findBlocks({
            matching: ['stone', 'deepslate', 'dirt', 'grass_block', 'tuff'].map(n => this.mcData.blocksByName[n]?.id).filter(n => n != null),
            maxDistance: 32, count: 64,
            useExtraInfo: block => {
                if (!block?.position) return false;
                const feet = block.position.offset(0, 1, 0);
                const head = this.bot.blockAt(feet.offset(0, 1, 0));
                return feet.y <= origin.y && origin.distanceTo(feet) > 4 &&
                    this.bot.blockAt(feet)?.name === 'air' && head?.name === 'air' &&
                    head.skyLight < 12;
            }
        }).map(p => p.offset(0, 1, 0)).filter(p => !this.visitedCaves.has(p.toString()));
        // Une grotte pres du filon requis passe avant une grotte seulement profonde.
        const score = p => detected.length ? Math.min(...detected.map(ore => ore.distanceTo(p))) : p.y;
        floors.sort((a, b) => score(a) - score(b));
        const original = this.bot.pathfinder.movements;
        const walking = existingPassageMovements(this.bot);
        for (const point of floors.slice(0, 12)) {
            if (threatNearPoint(this.bot, point, 3)) continue;
            const goal = new goals.GoalNear(point.x, point.y, point.z, 1);
            const route = await planCompletePath(this.bot, goal, 800, walking);
            if (route.status !== 'success' || threatNearPath(this.bot, route.path)) continue;
            this.visitedCaves.add(point.toString());
            this.caveMoves++;
            this.bot.chat(`[SpeedBot] Grotte accessible : recherche de ${this.oreName}.`);
            this.bot.pathfinder.setMovements(walking);
            try {
                await withTimeout(this.bot, this.bot.pathfinder.goto(goal), 15000, 'Acces a la grotte bloque');
                const vein = detected.sort((a, b) => a.distanceTo(point) - b.distanceTo(point))[0];
                if (vein) {
                    this.bot.caveMiningTarget = { oreName: this.oreName, position: vein.clone() };
                    this.bot.chat(`[SpeedBot] Filon de ${this.oreName} repere : approche depuis la grotte.`);
                    this.complete();
                }
            } catch (error) { console.log(`[DigDown] ${error.message}`); }
            finally { if (this.bot.pathfinder.movements === walking) this.bot.pathfinder.setMovements(original); }
            return true;
        }
        this.caveMoves = 3;
        this.bot.chat(`[SpeedBot] Pas de grotte accessible ici pour ${this.oreName} : descente en escalier.`);
        return false;
    }

    async stepInto(floor) {
        const walk = floor.offset(0.5, 0, 0.5);
        const arrived = () => {
            const pos = this.bot.entity.position;
            return this.bot.entity.onGround === true && Math.abs(pos.y - floor.y) < 0.05 &&
                Math.hypot(pos.x - walk.x, pos.z - walk.z) < 0.18;
        };
        try {
            for (let t = 0; t < 40; t++) {
                if (arrived()) {
                    this.bot.trail?.record(this.bot.entity.position, false);
                    return;
                }
                if (this.bot.isInCombat?.()) return;
                const pos = this.bot.entity.position;
                // Viser horizontalement et rester centre, meme si un autre systeme
                // a fait pivoter le regard pendant la descente.
                await this.bot.lookAt(new Vec3(walk.x, pos.y + 1.6, walk.z));
                const centered = Math.hypot(pos.x - walk.x, pos.z - walk.z) < 0.18;
                this.bot.setControlState('forward', !centered);
                await this.bot.waitForTicks(1);
            }
            this.fail('Marche non atteinte : descente interrompue pour proteger l escalier');
        } finally {
            this.bot.setControlState('forward', false);
        }
    }

    // Tourne de 90 degres (nouvelle direction verrouillee). Echoue apres 4 essais
    // consecutifs -> laisse le disjoncteur de l'Agent relocaliser le bot.
    async turn() {
        this.turns++;
        if (this.turns > 4) { this.turns = 0; return false; }
        const cur = Math.atan2(-this.dir.x, -this.dir.z);
        this.dir = this.cardinalFromYaw(cur - Math.PI / 2);
        await this.bot.waitForTicks(3);
        return true;
    }
}

module.exports = DigDown;
