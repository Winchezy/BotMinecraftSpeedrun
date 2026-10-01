const Task = require('../lib/Task');
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { withTimeout } = require('../lib/Pathing');

const FILLERS = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'andesite', 'diorite',
    'granite', 'tuff', 'netherrack', 'blackstone', 'deepslate'];

const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air');
const isFluid = b => !!b && /water|lava/.test(b.name);
const isSolid = b => !!b && b.boundingBox === 'block' && !isFluid(b);

// Plan d'un portail minimal (10 obsidiennes) dans le plan (along, vertical).
// u = position le long du cadre (-1..2), v = hauteur (0..4). Les 4 coins sont de
// simples blocs de soutien (n'importe quel materiau) : sans eux, les colonnes et le
// haut du cadre n'auraient aucun bloc voisin contre lequel etre poses.
function portalLayout(base, along) {
    const at = (u, v) => base.offset(along.x * u, v, along.z * u);
    const obsidian = [
        at(0, 0), at(1, 0),                     // bas
        at(-1, 1), at(-1, 2), at(-1, 3),        // colonne gauche
        at(2, 1), at(2, 2), at(2, 3),           // colonne droite
        at(0, 4), at(1, 4)                      // haut
    ];
    return {
        obsidian,
        bottomCorners: [at(-1, 0), at(2, 0)],
        topCorners: [at(-1, 4), at(2, 4)],
        interior: [at(0, 1), at(1, 1), at(0, 2), at(1, 2), at(0, 3), at(1, 3)],
        ground: [at(-1, -1), at(0, -1), at(1, -1), at(2, -1)],
        // Ordre de pose : chaque bloc a un voisin deja pose (ou le sol).
        order: [
            ['filler', at(-1, 0)], ['filler', at(2, 0)],
            ['obsidian', at(0, 0)], ['obsidian', at(1, 0)],
            ['obsidian', at(-1, 1)], ['obsidian', at(-1, 2)], ['obsidian', at(-1, 3)],
            ['obsidian', at(2, 1)], ['obsidian', at(2, 2)], ['obsidian', at(2, 3)],
            ['filler', at(-1, 4)], ['filler', at(2, 4)],
            ['obsidian', at(0, 4)], ['obsidian', at(1, 4)]
        ]
    };
}

// Evalue un emplacement : sol solide sous le cadre, rien de liquide/indestructible dans
// le cadre, et une case d'ou le bot atteint tout le cadre sans etre dedans.
function evaluateSite(bot, base, along) {
    const layout = portalLayout(base, along);
    if (!layout.ground.every(p => isSolid(bot.blockAt(p)))) return null;
    const volume = [...layout.obsidian, ...layout.interior, ...layout.bottomCorners, ...layout.topCorners];
    let toDig = 0;
    for (const p of volume) {
        const b = bot.blockAt(p);
        if (!b || isFluid(b) || b.name === 'bedrock' || b.name === 'nether_portal') return null;
        // Liquide juste au-dessus : il coulerait dans le portail une fois degage.
        if (isFluid(bot.blockAt(p.offset(0, 1, 0)))) return null;
        if (!isAir(b)) toDig++;
    }
    const front = new Vec3(along.z, 0, along.x);
    for (const side of [1, -1]) {
        const stand = base.offset(along.x * 0.5 + front.x * 3 * side, 0, along.z * 0.5 + front.z * 3 * side).floored();
        if (isAir(bot.blockAt(stand)) && isAir(bot.blockAt(stand.offset(0, 1, 0))) &&
            isSolid(bot.blockAt(stand.offset(0, -1, 0)))) {
            return { base, along, stand, layout, toDig };
        }
    }
    return null;
}

function findPortalSite(bot, radius = 6) {
    const origin = bot.entity.position.floored();
    let best = null;
    for (const along of [new Vec3(1, 0, 0), new Vec3(0, 0, 1)]) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                for (let dy = -2; dy <= 2; dy++) {
                    const site = evaluateSite(bot, origin.offset(dx, dy, dz), along);
                    if (!site) continue;
                    const score = site.toDig * 2 + bot.entity.position.distanceTo(site.stand);
                    if (!best || score < best.score) best = { ...site, score };
                }
            }
        }
    }
    return best;
}

class BuildNetherPortal extends Task {
    constructor(bot) {
        super(bot);
        this.name = 'BuildNetherPortal';
        this.site = null;
        this.lightAttempts = 0;
    }

    count(name) {
        return this.bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0);
    }

    async run() {
        const portalId = this.bot.registry.blocksByName.nether_portal.id;
        if (this.bot.findBlock({ matching: portalId, maxDistance: 16 })) {
            console.log(`[${this.name}] Portail actif a proximite.`);
            this.complete();
            return;
        }

        if (!this.site) {
            if (this.count('obsidian') < 10) { this.fail(`Pas assez d'obsidienne (${this.count('obsidian')}/10)`); return; }
            if (!this.bot.inventory.items().some(i => FILLERS.includes(i.name))) { this.fail('Pas de blocs de soutien (pierre/terre)'); return; }
            if (this.count('flint_and_steel') < 1) { this.fail('Pas de briquet'); return; }
            this.site = findPortalSite(this.bot);
            if (!this.site) { this.fail('Aucun emplacement pour le portail'); return; }
            console.log(`[${this.name}] Emplacement : base ${this.site.base}, axe ${this.site.along.x ? 'X' : 'Z'}, depuis ${this.site.stand}.`);
        }
        const { layout, stand } = this.site;

        // 1. Se placer devant le cadre.
        if (this.bot.entity.position.floored().distanceTo(stand) > 0.5) {
            try {
                await withTimeout(this.bot, this.bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)), 30000, 'trajet trop long');
            } catch (e) {
                console.log(`[${this.name}] Impossible d'atteindre l'emplacement : ${e.message}`);
                this.site = null;
                this.fail('Emplacement inaccessible');
            }
            return;
        }

        // 2. Degager le cadre et l'interieur (les coins deja solides servent de soutien).
        for (const p of [...layout.interior, ...layout.obsidian]) {
            const b = this.bot.blockAt(p);
            if (isAir(b) || b.name === 'obsidian' && layout.obsidian.some(o => o.equals(p))) continue;
            console.log(`[${this.name}] Degagement de ${b.name} en ${p}.`);
            try {
                const tool = this.bot.pathfinder.bestHarvestTool(b);
                if (tool) await this.bot.equip(tool, 'hand');
                await withTimeout(this.bot, this.bot.dig(b, true), 15000, 'minage trop long');
            } catch (e) {
                console.log(`[${this.name}] Degagement impossible : ${e.message}`);
                this.site = null; // on changera d'emplacement
            }
            return;
        }

        // 3. Poser le cadre dans l'ordre (un bloc par passage, verifie).
        for (const [kind, p] of layout.order) {
            const b = this.bot.blockAt(p);
            if (kind === 'obsidian' ? b?.name === 'obsidian' : isSolid(b)) continue;
            const item = kind === 'obsidian'
                ? this.bot.inventory.items().find(i => i.name === 'obsidian')
                : this.bot.inventory.items().find(i => FILLERS.includes(i.name));
            if (!item) { this.fail(`Plus de ${kind === 'obsidian' ? 'obsidienne' : 'blocs de soutien'}`); return; }
            if (!(await this.placeAt(p, item))) {
                this.placeFailures = (this.placeFailures || 0) + 1;
                if (this.placeFailures >= 6) this.fail(`Pose impossible en ${p}`);
            }
            return;
        }

        // 4. Allumer : briquet sur le dessus de l'obsidienne du bas.
        if (this.lightAttempts >= 3) { this.fail("Le portail ne s'allume pas"); return; }
        this.lightAttempts++;
        const lighter = this.bot.inventory.items().find(i => i.name === 'flint_and_steel');
        if (!lighter) { this.fail('Pas de briquet'); return; }
        const bottom = this.bot.blockAt(layout.obsidian[0]);
        console.log(`[${this.name}] Allumage du portail (essai ${this.lightAttempts}).`);
        await this.bot.equip(lighter, 'hand');
        await this.bot.lookAt(bottom.position.offset(0.5, 1, 0.5), true);
        try {
            await this.bot.activateBlock(bottom, new Vec3(0, 1, 0));
        } catch (e) {
            console.log(`[${this.name}] Allumage : ${e.message}`);
        }
        await this.bot.waitForTicks(20);
        if (layout.interior.some(p => this.bot.blockAt(p)?.name === 'nether_portal')) {
            console.log(`[${this.name}] Portail du Nether allume !`);
            this.complete();
        }
    }

    // Pose `item` en `pos` contre n'importe quel voisin solide.
    async placeAt(pos, item) {
        const dirs = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
        for (const d of dirs) {
            const ref = this.bot.blockAt(pos.plus(d));
            if (!isSolid(ref)) continue;
            try {
                await this.bot.equip(item, 'hand');
                await withTimeout(this.bot, this.bot.placeBlock(ref, d.scaled(-1)), 6000, 'pose trop longue');
            } catch (e) {
                // placeBlock attend la confirmation du serveur : on verifie le resultat reel.
            }
            if (this.bot.blockAt(pos)?.name === item.name ||
                (item.name !== 'obsidian' && isSolid(this.bot.blockAt(pos)))) return true;
        }
        console.log(`[${this.name}] Pose de ${item.name} impossible en ${pos}.`);
        return false;
    }
}

module.exports = BuildNetherPortal;
module.exports.portalLayout = portalLayout;
module.exports.findPortalSite = findPortalSite;
