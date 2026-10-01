const HOSTILE_MOBS = new Set([
    'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray',
    'cave_spider', 'creeper', 'witch', 'slime', 'phantom',
    'pillager', 'vindicator', 'ravager', 'blaze', 'ghast', 'magma_cube',
    'hoglin', 'piglin_brute', 'warden', 'wither_skeleton', 'endermite',
    'silverfish', 'guardian', 'elder_guardian', 'shulker'
]);

const NEUTRAL_MOBS = new Set([
    'enderman', 'piglin', 'zombified_piglin', 'spider'
]);

const AVOID_FIGHT = new Set([
    'creeper', 'warden', 'ravager', 'piglin_brute', 'ghast', 'blaze'
]);

function isHostileMob(entity) {
    return HOSTILE_MOBS.has(entity?.name);
}

function isNeutralMob(entity) {
    return NEUTRAL_MOBS.has(entity?.name);
}

function shouldFightStalemate(entity, { stuckMs, distance, health, sword, nearbyHostiles, threatState }) {
    return stuckMs >= 30000 && isHostileMob(entity) && !AVOID_FIGHT.has(entity.name) &&
        sword && health >= 10 && nearbyHostiles < 2 && distance <= 6 &&
        (threatState === 'vigilance' || threatState === 'hostile');
}

function decideResponse(entity, { distance, health, armed, nearbyHostiles, recentDamage, threatState }) {
    if (threatState === 'passive' && !recentDamage) return 'ignore';
    if (isNeutralMob(entity)) {
        // Damage alone does not identify the attacker, so retreat rather than provoke it.
        return (threatState === 'hostile' || recentDamage && distance < 4) ? 'retreat' : 'ignore';
    }
    if (!isHostileMob(entity) || distance > 18) return 'ignore';
    if (threatState === 'vigilance' && !recentDamage) {
        const safetyDistance = entity.name === 'creeper' ? 6 : /skeleton|stray|pillager/.test(entity.name) ? 8 : 4;
        return distance < safetyDistance ? 'retreat' : 'ignore';
    }
    if (threatState === 'hostile' && distance > 3.5) return 'retreat';
    if (entity.name === 'creeper') return distance < 16 ? 'retreat' : 'ignore';
    if ((entity.name === 'skeleton' || entity.name === 'stray') && distance < 14) return 'retreat';
    if (nearbyHostiles >= 2 && distance < 16) return 'retreat';
    if (recentDamage && distance > 3.5) return 'retreat';
    if (AVOID_FIGHT.has(entity.name)) return distance < 12 ? 'retreat' : 'ignore';
    if (distance > 8) return 'ignore';
    if (health < 10 || !armed || nearbyHostiles >= 2) return 'retreat';
    return distance <= 3.5 ? 'fight' : 'retreat';
}

class MobAwareness {
    constructor(bot) { this.bot = bot; this.observations = new Map(); }

    markAttack(entity, now = Date.now()) {
        if (!entity?.position) return;
        const record = this.observations.get(entity.id) || {};
        record.attackedAt = now;
        this.observations.set(entity.id, record);
    }

    observe(entity, now = Date.now()) {
        const position = this.bot.entity.position;
        const distance = position.distanceTo(entity.position);
        const old = this.observations.get(entity.id) || {};
        const keys = this.bot.registry?.entitiesByName?.[entity.name]?.metadataKeys || [];
        const meta = name => entity.metadata?.[keys.indexOf(name)];
        const aggressive = (Number(meta('mob_flags')) & 4) !== 0 ||
            meta('creepy') === true || meta('stared_at') === true ||
            Number(meta('swell_dir')) > 0 || meta('is_ignited') === true ||
            meta('is_charging_crossbow') === true;
        let pursuit = old.pursuit || 0;
        if (old.position && now - old.seenAt >= 200) {
            const dx = entity.position.x - old.position.x;
            const dz = entity.position.z - old.position.z;
            const towardX = position.x - entity.position.x;
            const towardZ = position.z - entity.position.z;
            const moved = Math.hypot(dx, dz);
            const alignment = (dx * towardX + dz * towardZ) / (moved * Math.hypot(towardX, towardZ) || 1);
            pursuit = moved > 0.12 && alignment > 0.75 ? pursuit + 1 : 0;
        }
        const attacked = old.attackedAt != null && now - old.attackedAt < 10000;
        // Un mob neutre peut marcher vers nous sans nous viser : ce mouvement
        // ne prouve pas qu'il nous attaque (notamment les Endermen).
        const probablePursuit = isHostileMob(entity) && pursuit >= 2 &&
            distance < 16 && Math.abs(position.y - entity.position.y) <= 4 &&
            require('./MobSafety').hasMobAccess(this.bot, position, entity);
        const hostileUntil = probablePursuit || aggressive ? now + 3000 : (old.hostileUntil || 0);
        const state = attacked || aggressive || hostileUntil > now ? 'hostile' :
            distance < (entity.name === 'creeper' ? 10 : 16) && isHostileMob(entity) ? 'vigilance' : 'passive';
        this.observations.set(entity.id, { ...old, position: entity.position.clone(), pursuit, seenAt: now, state, hostileUntil });
        return { state, distance, evidence: attacked ? 'attaque recue' : aggressive ? 'etat agressif transmis' : probablePursuit ? 'poursuite probable' : 'aucune attaque observee' };
    }

    prune(now = Date.now()) {
        for (const [id, record] of this.observations) {
            if (!this.bot.entities[id] || now - (record.seenAt || 0) > 30000) this.observations.delete(id);
        }
    }
}

module.exports = { isHostileMob, isNeutralMob, decideResponse, shouldFightStalemate, MobAwareness };
