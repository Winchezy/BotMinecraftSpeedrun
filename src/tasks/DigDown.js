const Task = require('../lib/Task');
const Vec3 = require('vec3').Vec3;

// Descente en escalier 1x1, robuste :
// - direction VERROUILLEE au 1er tick (evite la derive erratique quand Survival
//   fait pivoter le bot),
// - dig/placeBlock bornes dans le temps (jamais de gel),
// - detection des liquides (on ne creuse pas dans l'eau/lave, on contourne),
// - vrai "bridging" des vides/grottes (pose reelle d'un bloc).
class DigDown extends Task {
    constructor(bot, targetY) {
        super(bot);
        this.name = 'DigDown';
        this.targetY = targetY;
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
        try {
            await Promise.race([
                this.bot.dig(block),
                new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 8000))
            ]);
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
        const pos = this.bot.entity.position;
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

        // Diamants a proximite ? on s'arrete pour les miner.
        const diamondIds = [
            this.mcData.blocksByName.diamond_ore?.id,
            this.mcData.blocksByName.deepslate_diamond_ore?.id
        ].filter(x => x != null);
        const diamond = this.bot.findBlock({ matching: diamondIds, maxDistance: 4 });
        if (diamond) {
            console.log(`[DigDown] Diamant repere a ${diamond.position} !`);
            this.complete();
            return;
        }

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

    async stepInto(floor) {
        const walk = floor.offset(0.5, 0, 0.5);
        if (this.bot.entity.position.distanceSquared(walk) <= 0.25) return;
        await this.bot.lookAt(walk);
        this.bot.setControlState('forward', true);
        let t = 0;
        while (this.bot.entity.position.distanceSquared(walk) > 0.25 && t < 30) {
            await this.bot.waitForTicks(1); t++;
        }
        this.bot.setControlState('forward', false);
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
