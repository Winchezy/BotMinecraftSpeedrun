const { Vec3 } = require('vec3');
const { isHostileMob } = require('./MobThreats');
const { safeExplorationStep } = require('./ExplorationSafety');

class CombatTactics {
    constructor(bot) {
        this.bot = bot;
        this.jumpTicks = 0;
        this.dodgeTicks = 0;
        this.side = 1;
        this.attackTicks = 0;
        const original = bot.pvp.attemptAttack.bind(bot.pvp);
        bot.pvp.attemptAttack = () => this.attemptAttack(original);
        // Respecter la recharge complete plutot que l'offset aleatoire du plugin.
        bot.pvp.meleeAttackRate = { getTicks: () =>
            require('mineflayer-pvp/lib/Cooldown').getCooldown(bot.heldItem?.name) + 1 };
    }

    safeJump() {
        const bot = this.bot;
        const feet = bot.entity.position.floored();
        return bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava &&
            !bot.entity.isOnLadder && !Object.values(bot.entity.effects || {}).length &&
            safeExplorationStep(bot, feet) && [2, 3].every(y => bot.blockAt(feet.offset(0, y, 0))?.name === 'air');
    }

    attemptAttack(original) {
        const bot = this.bot;
        const target = bot.pvp.target;
        if (!target || !bot.isInCombat?.()) return original();
        if (this.attackTicks > 0) return;
        const strike = () => {
            this.attackTicks = 7;
            bot.combatAttackPending = true;
            return original();
        };
        if (this.jumpFallback) { this.jumpFallback = false; return strike(); }
        if (!bot.isInCombat?.() || !isHostileMob(target) || !bot.heldItem?.name.endsWith('_sword') ||
            bot.entity.position.distanceTo(target.position) > bot.pvp.attackRange) return strike();
        if (this.jumpTicks > 0) {
            const height = bot.entity.position.y - this.jumpY;
            if (!bot.entity.onGround && bot.entity.velocity.y < -0.02 && height > 0.4) {
                this.jumpTicks = 0;
                bot.setControlState('jump', false);
                return strike();
            }
            bot.pvp.timeToNextAttack = 0;
            return;
        }
        if (!this.safeJump()) return strike();
        this.jumpY = bot.entity.position.y;
        this.jumpTicks = 16;
        bot.setControlState('sprint', false);
        bot.setControlState('jump', true);
        bot.pvp.timeToNextAttack = 0;
    }

    incomingProjectile() {
        const bot = this.bot;
        const aim = bot.entity.position.offset(0, 1, 0);
        return Object.values(bot.entities).find(e => {
            if (!/^(arrow|spectral_arrow|fireball|small_fireball)$/.test(e.name || '') || !e.position || !e.velocity) return false;
            const v = e.velocity;
            const speed2 = v.dot(v);
            if (speed2 < 0.001 || e.position.distanceTo(aim) > 20) return false;
            const delta = aim.minus(e.position);
            const time = delta.dot(v) / speed2;
            return time > 0 && time < 20 && e.position.plus(v.scaled(time)).distanceTo(aim) < 2;
        });
    }

    tick(mode, target) {
        const bot = this.bot;
        if (this.attackTicks > 0 && --this.attackTicks === 0) bot.combatAttackPending = false;
        if (this.jumpTicks > 0 && --this.jumpTicks === 0) {
            bot.setControlState('jump', false);
            // Un saut rate ne doit jamais suspendre les attaques indefiniment.
            this.jumpY = null;
            this.jumpFallback = true;
        }
        if (!mode || !target) { this.reset(); return; }
        const projectile = this.incomingProjectile();
        if (!projectile && !this.dodgeTicks) { this.circleStrafe(mode,target); return; }
        if (this.strafeControl) { bot.setControlState(this.strafeControl,false); this.strafeControl=null; }
        if (!bot.entity.onGround || this.jumpTicks > 0) return;
        if (!this.dodgeTicks) {
            this.side *= -1;
            this.dodgeTicks = 6;
        }
        const velocity = projectile?.velocity;
        const angle = velocity ? Math.atan2(-velocity.x, -velocity.z) : this.dodgeYaw;
        this.dodgeYaw = angle;
        const yaw = bot.entity.yaw;
        // Mouvement lateral par rapport au regard actuel ; choisir le cote
        // perpendiculaire au projectile, sans imposer une rotation au bouclier.
        const worldSide = new Vec3(Math.cos(angle) * this.side, 0, -Math.sin(angle) * this.side);
        const left = new Vec3(Math.cos(yaw), 0, -Math.sin(yaw));
        const control = left.dot(worldSide) >= 0 ? 'left' : 'right';
        const sign = control === 'left' ? 1 : -1;
        const feet = bot.entity.position;
        const destination = feet.plus(left.scaled(sign * 0.8)).floored();
        if (!safeExplorationStep(bot, destination) ||
            bot.blockAt(destination)?.boundingBox !== 'empty' ||
            bot.blockAt(destination.offset(0, 1, 0))?.boundingBox !== 'empty' ||
            /water|lava|fire|powder_snow/.test(bot.blockAt(destination)?.name || '')) {
            this.stopDodge(); return;
        }
        // Le trajet habituel ne doit pas ecraser l'esquive durant ces six ticks.
        bot.pathfinder.setGoal(null);
        if (mode === 'fight') bot.shieldStoppedChase = true;
        bot.setControlState('forward', false);
        bot.setControlState('back', false);
        bot.setControlState('left', control === 'left');
        bot.setControlState('right', control === 'right');
        if (--this.dodgeTicks <= 0) this.stopDodge();
    }

    stopDodge() {
        this.dodgeTicks = 0;
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
    }

    circleStrafe(mode, target) {
        const bot = this.bot;
        const previous = this.strafeControl;
        let control = null;
        if (mode === 'fight' && isHostileMob(target) && bot.entity.onGround && !this.jumpTicks &&
            bot.entity.position.distanceTo(target.position) <= (bot.pvp.attackRange || 3) &&
            (!bot.actions || bot.actions.current?.owner === 'combat')) {
            control = require('./CombatStrafe').circleDirection(target,bot.entity.position);
            if (control) {
                const sign = control === 'left' ? 1 : -1;
                const direction = new Vec3(Math.cos(bot.entity.yaw),0,-Math.sin(bot.entity.yaw));
                const next = bot.entity.position.plus(direction.scaled(sign*0.8)).floored();
                if (!safeExplorationStep(bot,next) || bot.blockAt(next)?.boundingBox !== 'empty' ||
                    bot.blockAt(next.offset(0,1,0))?.boundingBox !== 'empty') control=null;
            }
        }
        if (previous && previous !== control) bot.setControlState(previous,false);
        this.strafeControl=control;
        if (control) {
            bot.pathfinder.setGoal(null);
            bot.shieldStoppedChase=true;
            bot.setControlState(control,true);
        }
    }

    reset() {
        this.attackTicks = 0;
        this.bot.combatAttackPending = false;
        if (this.strafeControl) this.bot.setControlState(this.strafeControl,false);
        this.strafeControl = null;
        if (this.jumpTicks) this.bot.setControlState('jump', false);
        this.jumpTicks = 0;
        this.jumpFallback = false;
        if (this.dodgeTicks) this.stopDodge();
    }
}

module.exports = CombatTactics;
