const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { withTimeout } = require('../lib/Pathing');

const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const REACH = 4.3;          // oeil -> point vise (marge sous la portee de 4.5)
const LAVA_LEVEL_Y = -54;   // sous Y=-55, les grottes sont remplies de lave

const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air');
const isFluid = b => !!b && (b.name === 'water' || b.name === 'lava');
const isFloor = b => !!b && b.boundingBox === 'block' && !isFluid(b);

// Ou verser l'eau pour qu'elle coule sur la source de lave `lava` (on vise le dessus
// du sol de cette case) :
//  - une case d'air voisine au meme niveau, sur un sol solide ;
//  - sinon (mare encastree, bordee d'un muret) une case d'air sur le bord, 1 ou 2
//    crans plus haut : l'eau passe au-dessus de la lave et retombe dessus. Il faut
//    que la colonne au-dessus de la lave soit libre jusqu'a ce niveau.
function findPourSpot(bot, lava) {
    for (let dy = 0; dy <= 2; dy++) {
        if (dy > 0 && !isAir(bot.blockAt(lava.offset(0, dy, 0)))) return null;
        for (const [dx, dz] of HORIZONTAL) {
            const pour = lava.offset(dx, dy, dz);
            if (isAir(bot.blockAt(pour)) && isFloor(bot.blockAt(pour.offset(0, -1, 0)))) return pour;
        }
    }
    return null;
}

// Case ou se tenir : sol sec, 2 blocs d'air, a distance de la lave, a portee du point vise.
function findStandSpot(bot, pour, lava) {
    const target = pour.offset(0.5, 0, 0.5);
    let best = null;
    for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                const feet = pour.offset(dx, dy, dz);
                const flat = Math.hypot(dx, dz);
                if (flat < 1.5 || feet.equals(lava)) continue;
                if (!isAir(bot.blockAt(feet)) || !isAir(bot.blockAt(feet.offset(0, 1, 0))) ||
                    !isFloor(bot.blockAt(feet.offset(0, -1, 0)))) continue;
                if (feet.offset(0.5, 1.62, 0.5).distanceTo(target) > REACH) continue;
                let nearLava = false;
                for (let x = -1; x <= 1 && !nearLava; x++)
                    for (let y = -1; y <= 1 && !nearLava; y++)
                        for (let z = -1; z <= 1 && !nearLava; z++)
                            if (bot.blockAt(feet.offset(x, y, z))?.name === 'lava') nearLava = true;
                if (nearLava) continue;
                const d = bot.entity.position.distanceTo(feet);
                if (!best || d < best.d) best = { pos: feet, d };
            }
        }
    }
    return best?.pos || null;
}

// Fabrique de l'obsidienne : eau versee a cote d'une source de lave, eau recuperee,
// puis minage a la pioche en diamant. Bien plus fiable que chercher de l'obsidienne
// naturelle (rare). Sans lave a portee, descend vers Y=-54 ou la lave abonde.
class MakeObsidian extends Task {
    constructor(bot, target = 10) {
        super(bot);
        this.name = 'MakeObsidian';
        this.target = target;
        this.failures = new Map(); // position -> echecs
        this.descent = null;
    }

    count(name) {
        return this.bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0);
    }

    skip(pos) { return (this.failures.get(pos.toString()) || 0) >= 2; }
    strike(pos) { this.failures.set(pos.toString(), (this.failures.get(pos.toString()) || 0) + 1); }

    async run() {
        if (this.count('obsidian') >= this.target) { this.complete(); return; }
        const items = this.bot.inventory.items();
        if (!items.some(i => i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe')) {
            this.fail('Pas de pioche en diamant');
            return;
        }

        // 1. Obsidienne deja presente (fabriquee au tour precedent, ou naturelle) -> miner.
        const obsidian = this.findObsidian();
        if (obsidian) { await this.mine(obsidian); return; }

        if (!items.some(i => i.name === 'water_bucket')) { this.fail("Pas de seau d'eau"); return; }

        // 2. Source de lave exploitable -> verser l'eau.
        const spot = this.findLavaSpot();
        if (spot) { await this.pour(spot); return; }

        // 3. Pas de lave : descendre au niveau de la lave.
        if (this.bot.entity.position.y > LAVA_LEVEL_Y + 4) {
            if (!this.descent || this.descent.isDone()) {
                if (this.descent?.hasFailed) { this.fail(`Pas de lave et descente impossible (${this.descent.failureReason})`); return; }
                const DigDown = require('./DigDown');
                console.log('[MakeObsidian] Pas de lave a portee -> descente vers Y=-54.');
                this.descent = new DigDown(this.bot, LAVA_LEVEL_Y);
            }
            await this.descent.run();
            return;
        }
        this.fail('Pas de lave');
    }

    findObsidian() {
        const id = this.bot.registry.blocksByName.obsidian.id;
        const portalId = this.bot.registry.blocksByName.nether_portal.id;
        const positions = this.bot.findBlocks({ matching: id, maxDistance: 16, count: 30 });
        for (const pos of positions) {
            if (this.skip(pos)) continue;
            // Ne jamais demonter un cadre de portail.
            if (this.bot.findBlock({ matching: portalId, maxDistance: 3, point: pos })) continue;
            return this.bot.blockAt(pos);
        }
        return null;
    }

    findLavaSpot() {
        const lavaId = this.bot.registry.blocksByName.lava.id;
        const positions = this.bot.findBlocks({ matching: lavaId, maxDistance: 32, count: 300 });
        const spots = [];
        for (const lava of positions) {
            const block = this.bot.blockAt(lava);
            if (!block || block.metadata !== 0 || this.skip(lava)) continue; // sources seulement
            const pour = findPourSpot(this.bot, lava);
            if (!pour) continue;
            const stand = findStandSpot(this.bot, pour, lava);
            if (!stand) continue;
            // Preferer une lave posee sur du solide : l'obsidienne minee ne tombera pas dans la lave.
            const solidBelow = isFloor(this.bot.blockAt(lava.offset(0, -1, 0)));
            spots.push({ lava, pour, stand, score: this.bot.entity.position.distanceTo(stand) + (solidBelow ? 0 : 20) });
        }
        spots.sort((a, b) => a.score - b.score);
        return spots[0] || null;
    }

    async pour({ lava, pour, stand }) {
        console.log(`[MakeObsidian] Lave ${lava} : eau versee en ${pour} depuis ${stand}.`);
        try {
            await withTimeout(this.bot, this.bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)), 30000, 'trajet trop long');
            const floor = pour.offset(0, -1, 0);
            await this.bot.equip(this.bot.inventory.items().find(i => i.name === 'water_bucket'), 'hand');
            await this.bot.lookAt(pour.offset(0.5, 0.05, 0.5), true);
            await this.bot.waitForTicks(2); // lookAt(force) n'envoie la rotation qu'au tick suivant
            const cursor = this.bot.blockAtCursor(5);
            if (!cursor || !cursor.position.equals(floor) || cursor.face !== 1) {
                throw new Error(`vise ${cursor?.name || 'rien'} au lieu du sol`);
            }
            this.bot.activateItem();
            await this.bot.waitForTicks(20);
        } catch (e) {
            console.log(`[MakeObsidian] Echec du versement : ${e.message}`);
            this.strike(lava);
            return;
        }

        await this.recoverWater(pour);
        if (this.bot.blockAt(lava)?.name === 'obsidian') {
            console.log(`[MakeObsidian] Obsidienne creee en ${lava}.`);
        } else {
            this.strike(lava);
        }
    }

    // Reprendre l'eau versee : on garde le seau pour les prochaines sources.
    async recoverWater(pour) {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this.bot.inventory.items().some(i => i.name === 'water_bucket')) return;
            const bucket = this.bot.inventory.items().find(i => i.name === 'bucket');
            const water = this.bot.blockAt(pour);
            if (!bucket || water?.name !== 'water') break;
            await this.bot.equip(bucket, 'hand');
            await this.bot.lookAt(pour.offset(0.5, 0.5, 0.5), true);
            await this.bot.waitForTicks(2); // lookAt(force) n'envoie la rotation qu'au tick suivant
            this.bot.activateItem();
            await this.bot.waitForTicks(5);
        }
        if (!this.bot.inventory.items().some(i => i.name === 'water_bucket')) {
            console.log("[MakeObsidian] Eau non recuperee (le seau sera rempli a nouveau).");
        }
    }

    async mine(block) {
        const before = this.count('obsidian');
        // Pieds dans l'eau = minage 5x plus lent (~47 s par obsidienne) : on laisse
        // l'eau ecoulee se retirer (quelques secondes une fois la source reprise).
        const inWater = () => /water/.test(this.bot.blockAt(this.bot.entity.position.floored())?.name || '');
        for (let i = 0; i < 20 && inWater(); i++) await this.bot.waitForTicks(5);
        console.log(`[MakeObsidian] Minage de l'obsidienne en ${block.position} (${before}/${this.target}).`);
        try {
            // ~9,4 s par bloc a la pioche en diamant.
            await withTimeout(this.bot, this.bot.collectBlock.collect(block), 45000, 'minage trop long');
        } catch (e) {
            console.log(`[MakeObsidian] Minage interrompu : ${e.message}`);
        }
        if (this.count('obsidian') <= before) this.strike(block.position);
    }
}

module.exports = MakeObsidian;
module.exports.findPourSpot = findPourSpot;
module.exports.findStandSpot = findStandSpot;
