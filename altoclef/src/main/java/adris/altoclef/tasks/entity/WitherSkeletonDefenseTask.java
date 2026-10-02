package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasks.construction.ProjectileProtectionWallTask;
import adris.altoclef.tasks.movement.RunAwayFromHostilesTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.*;
import adris.altoclef.util.time.TimerGame;
import baritone.api.utils.input.Input;
import net.minecraft.block.Blocks;
import net.minecraft.entity.Entity;
import net.minecraft.entity.effect.StatusEffects;
import net.minecraft.entity.mob.*;
import net.minecraft.item.Item;
import net.minecraft.item.Items;
import net.minecraft.item.ItemStack;
import net.minecraft.util.Hand;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.hit.HitResult;
import java.util.Optional;

/** A bounded defensive action: no mining, no wandering while constructing protection. */
public class WitherSkeletonDefenseTask extends Task {
    private static final Item[] MATERIALS = { Items.COBBLESTONE, Items.NETHERRACK, Items.DIRT,
            Items.COBBLED_DEEPSLATE, Items.BLACKSTONE, Items.STONE };
    private enum Stage { PLAN, BARRIER, TOWER, FIGHT, FLEE }
    private final WitherSkeletonEntity target;
    private final TimerGame constructionTimeout = new TimerGame(4);
    private final TimerGame fightTimeout = new TimerGame(10);
    private final TimerGame placementDelay = new TimerGame(0.15);
    private final Task escape = new RunAwayFromHostilesTask(30, true);
    private Stage stage = Stage.PLAN;
    private BlockPos base, barrier;
    private boolean tower;
    private float lastHealth;
    private float targetHealth;
    private int lastHurtTime;

    public WitherSkeletonDefenseTask(WitherSkeletonEntity target) { this.target = target; }
    public boolean matches(Entity entity) { return entity == target; }

    private void transition(Stage next, String message) {
        if (stage != next) Debug.logMessage(message);
        stage = next;
        setDebugState(message);
    }

    @Override protected void onStart() {
        AltoClef mod = AltoClef.getInstance();
        base = mod.getPlayer().getBlockPos();
        lastHealth = mod.getPlayer().getHealth();
        targetHealth = target.getHealth();
        lastHurtTime = mod.getPlayer().hurtTime;
        stage = Stage.PLAN;
        tower = false;
        barrier = null;
        constructionTimeout.reset();
        fightTimeout.reset();
        placementDelay.forceElapse();
        mod.getClientBaritone().getPathingBehavior().forceCancel();
    }

    private boolean rangedThreat(AltoClef mod) {
        return mod.getEntityTracker().getHostiles().stream().anyMatch(entity -> entity != target
                && (entity instanceof AbstractSkeletonEntity && !(entity instanceof WitherSkeletonEntity)
                    || entity instanceof BlazeEntity || entity instanceof GhastEntity
                    || entity instanceof PillagerEntity || entity instanceof PiglinEntity || entity instanceof WitchEntity)
                && entity.isInRange(mod.getPlayer(), 24) && EntityHelper.isAngryAtPlayer(mod, entity));
    }

    private boolean otherClose(AltoClef mod) {
        return mod.getEntityTracker().getHostiles().stream().anyMatch(entity -> entity != target
                && entity.isInRange(mod.getPlayer(), 6) && EntityHelper.isAngryAtPlayer(mod, entity));
    }

    private boolean headroom(AltoClef mod) {
        for (int y = 2; y <= 6; y++) {
            if (!mod.getWorld().getBlockState(base.up(y)).isAir()
                    || !mod.getWorld().getBlockState(base.up(y)).getFluidState().isEmpty()) return false;
        }
        return true;
    }

    private boolean roof(AltoClef mod) {
        if (!CombatGroundHelper.isSafeColumn(mod, base)) return false;
        for (int x = -1; x <= 1; x++) for (int z = -1; z <= 1; z++)
            if (!WorldHelper.isSolidBlock(base.add(x, 2, z))) return false;
        return true;
    }

    private Optional<BlockPos> corridorBarrier(AltoClef mod, boolean building) {
        double vx = target.getX() - mod.getPlayer().getX(), vz = target.getZ() - mod.getPlayer().getZ();
        int dx = Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 1 : -1) : 0;
        int dz = dx == 0 ? (vz > 0 ? 1 : -1) : 0;
        if (vx * dx + vz * dz < (building ? 2.5 : 1.5) || Math.abs(-vx * dz + vz * dx) > 1.2
                || Math.abs(target.getY() - base.getY()) > 0.6) return Optional.empty();
        for (int row = 0; row <= 1; row++) for (int side : new int[] {-1, 1}) {
            if (!WorldHelper.isSolidBlock(base.add(row * dx - side * dz, 1, row * dz + side * dx)))
                return Optional.empty();
        }
        BlockPos front = base.add(dx, 0, dz);
        if (!CombatGroundHelper.isSafeColumn(mod, base) || !CombatGroundHelper.isSafeColumn(mod, front))
            return Optional.empty();
        BlockPos result = front.up(2);
        ProjectileProtectionWallTask placer = new ProjectileProtectionWallTask(mod);
        if (WorldHelper.isSolidBlock(result) || (mod.getWorld().getBlockState(result).isAir()
                && placer.getPlaceSide(result) != null && placer.canPlace(result))) return Optional.of(result);
        return Optional.empty();
    }

    private void place(AltoClef mod, BlockPos position) {
        if (!placementDelay.elapsed()) return;
        ProjectileProtectionWallTask placer = new ProjectileProtectionWallTask(mod);
        // Avoid the old placement utility's recursive support-building fallback.
        if (placer.getPlaceSide(position) == null || !placer.canPlace(position)) return;
        if (!mod.getSlotHandler().forceEquipItem(MATERIALS, false)) return;
        if (placer.place(position, Hand.MAIN_HAND, mod.getPlayer().getInventory().selectedSlot)) placementDelay.reset();
    }

    private void release(AltoClef mod) {
        mod.getInputControls().release(Input.JUMP);
        mod.getInputControls().release(Input.SNEAK);
        mod.getInputControls().release(Input.CLICK_RIGHT);
    }

    private void fallback(AltoClef mod, String reason) {
        boolean canTower = WitherDefensePolicy.choose(false, CombatGroundHelper.hasRetreatMargin(mod, base),
                headroom(mod), rangedThreat(mod), otherClose(mod), mod.getItemStorage().getItemCount(MATERIALS),
                target.distanceTo(mod.getPlayer()), mod.getPlayer().getHealth(),
                mod.getPlayer().hasStatusEffect(StatusEffects.WITHER)) == WitherDefensePolicy.Choice.TOWER;
        if (!tower && canTower && mod.getPlayer().getBlockPos().equals(base)
                && Math.abs(mod.getPlayer().getX() - (base.getX() + 0.5)) <= 0.3
                && Math.abs(mod.getPlayer().getZ() - (base.getZ() + 0.5)) <= 0.3) {
            tower = true;
            constructionTimeout.reset();
            transition(Stage.TOWER, reason + " Je tente une tour sur terrain degage.");
        } else transition(Stage.FLEE, reason + " Je fuis.");
    }

    private void attack(AltoClef mod) {
        if (AbstractKillEntityTask.equipWeapon(mod)) return;
        LookHelper.lookAt(mod, target.getEyePos());
        var hit = LookHelper.raycast(mod.getPlayer(), target, mod.getModSettings().getEntityReachRange());
        if (hit != null && hit.getType() == HitResult.Type.ENTITY && mod.getControllerExtras().inRange(target)
                && mod.getPlayer().getAttackCooldownProgress(0) >= 1) {
            mod.getControllerExtras().attack(target);
        }
    }

    @Override protected Task onTick() {
        AltoClef mod = AltoClef.getInstance();
        if (!target.isAlive()) { release(mod); return null; }
        if (target.getHealth() < targetHealth) fightTimeout.reset();
        targetHealth = target.getHealth();
        boolean hurt = mod.getPlayer().getHealth() < lastHealth || mod.getPlayer().hurtTime > lastHurtTime;
        lastHealth = mod.getPlayer().getHealth();
        lastHurtTime = mod.getPlayer().hurtTime;
        if (mod.getPlayer().hasStatusEffect(StatusEffects.WITHER) || lastHealth <= 10
                || otherClose(mod) || (hurt && stage != Stage.PLAN)) {
            transition(Stage.FLEE, "Wither squelette : protection insuffisante, je fuis.");
        }
        if (stage == Stage.PLAN) {
            Optional<BlockPos> corridor = corridorBarrier(mod, true);
            boolean existingRoof = roof(mod);
            boolean canBuildBarrier = corridor.isPresent()
                    && (WorldHelper.isSolidBlock(corridor.get()) || mod.getItemStorage().getItemCount(MATERIALS) > 0)
                    && target.distanceTo(mod.getPlayer()) >= 4;
            switch (WitherDefensePolicy.choose(existingRoof || canBuildBarrier,
                    CombatGroundHelper.hasRetreatMargin(mod, base)
                        && Math.abs(mod.getPlayer().getX() - (base.getX() + 0.5)) <= 0.3
                        && Math.abs(mod.getPlayer().getZ() - (base.getZ() + 0.5)) <= 0.3,
                    headroom(mod), rangedThreat(mod), otherClose(mod),
                    mod.getItemStorage().getItemCount(MATERIALS), target.distanceTo(mod.getPlayer()), lastHealth, false)) {
                case SHELTER -> {
                    barrier = corridor.orElse(null);
                    if (existingRoof || barrier != null && WorldHelper.isSolidBlock(barrier)) {
                        transition(Stage.FIGHT, "Wither squelette : je frappe depuis un abri bas.");
                    } else transition(Stage.BARRIER, "Wither squelette : je ferme le haut du passage.");
                }
                case TOWER -> {
                    tower = true;
                    transition(Stage.TOWER, "Wither squelette : je construis une tour de trois blocs sur un sol sur.");
                }
                case FLEE -> transition(Stage.FLEE, "Wither squelette : aucun abri sur, je fuis avant le contact.");
            }
        }
        if (stage == Stage.BARRIER) {
            if (WorldHelper.isSolidBlock(barrier)) {
                fightTimeout.reset();
                transition(Stage.FIGHT, "Wither squelette : passage bas ferme, je garde ma position.");
            } else if (constructionTimeout.elapsed() || target.distanceTo(mod.getPlayer()) < 3.5) {
                fallback(mod, "Wither squelette : je ne peux pas fermer le passage a temps.");
            } else { place(mod, barrier); return null; }
        }
        if (stage == Stage.TOWER) {
            int built = 0;
            while (built < 3 && WorldHelper.isSolidBlock(base.up(built))) built++;
            if (built == 3 && mod.getPlayer().getBlockPos().equals(base.up(3)) && mod.getPlayer().isOnGround()) {
                release(mod);
                fightTimeout.reset();
                transition(Stage.FIGHT, "Wither squelette : tour terminee, je frappe depuis le sommet.");
            } else if (rangedThreat(mod) || constructionTimeout.elapsed() || target.distanceTo(mod.getPlayer()) < 3.5) {
                transition(Stage.FLEE, "Wither squelette : construction de tour dangereuse, je fuis.");
            } else {
                    if (Math.abs(mod.getPlayer().getX() - (base.getX() + 0.5)) > 0.35
                            || Math.abs(mod.getPlayer().getZ() - (base.getZ() + 0.5)) > 0.35) {
                        transition(Stage.FLEE, "Wither squelette : je ne suis pas centre sur la tour, je fuis.");
                    } else {
                        mod.getInputControls().hold(Input.JUMP);
                        if (built < 3 && mod.getPlayer().getY() >= base.getY() + built + 1.02) place(mod, base.up(built));
                        return null;
                    }
            }
        }
        if (stage == Stage.FIGHT) {
            boolean protectedPosition = tower
                    ? mod.getPlayer().getBlockPos().equals(base.up(3)) && WorldHelper.isSolidBlock(base.up(2))
                        && target.getY() <= base.getY() + 0.5
                    : mod.getPlayer().getBlockPos().equals(base) && (roof(mod)
                        || corridorBarrier(mod, false).filter(pos -> WorldHelper.isSolidBlock(pos)).isPresent());
            if (!protectedPosition || fightTimeout.elapsed() || rangedThreat(mod)
                    || (!tower && target.distanceTo(mod.getPlayer())
                        < WitherDefensePolicy.safeMeleeDistance(target.getWidth(), mod.getPlayer().getWidth()))) {
                fallback(mod, "Wither squelette : l'abri ne protege plus ou ne permet pas de frapper.");
            } else { attack(mod); return null; }
        }
        if (stage == Stage.FLEE) { release(mod); return escape; }
        return null;
    }

    @Override protected void onStop(Task interruptTask) { release(AltoClef.getInstance()); }
    @Override public boolean isFinished() {
        AltoClef mod = AltoClef.getInstance();
        return !target.isAlive() || target.getWorld() != mod.getWorld() || target.distanceTo(mod.getPlayer()) > 16;
    }
    @Override protected boolean isEqual(Task other) { return other instanceof WitherSkeletonDefenseTask task && task.target == target; }
    @Override protected String toDebugString() { return "Defense Wither squelette : " + stage; }
}
