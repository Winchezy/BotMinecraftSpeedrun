package adris.altoclef.util.helpers;

import adris.altoclef.AltoClef;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import java.util.Optional;
import java.util.WeakHashMap;
import java.util.function.Predicate;

public final class CombatGroundHelper {
    private static final WeakHashMap<AltoClef, RetreatCache> retreats = new WeakHashMap<>();
    private static final class RetreatCache {
        Object world;
        BlockPos origin;
        long tick;
        Optional<BlockPos> anchor;
    }
    private CombatGroundHelper() {}

    public static Optional<BlockPos> findRetreatAnchor(AltoClef mod) {
        BlockPos origin = mod.getPlayer().getBlockPos();
        long tick = mod.getWorld().getTime();
        RetreatCache cache = retreats.get(mod);
        if (cache != null && cache.world == mod.getWorld() && cache.origin.equals(origin)
                && tick >= cache.tick && tick - cache.tick < 20
                && (cache.anchor.isEmpty() || hasRetreatMargin(mod, cache.anchor.get()))) return cache.anchor;
        cache = new RetreatCache();
        cache.world = mod.getWorld();
        cache.origin = origin;
        cache.tick = tick;
        cache.anchor = findSafeAnchor(mod, origin, 8, pos -> true);
        retreats.put(mod, cache);
        return cache.anchor;
    }

    public static boolean isSafeColumn(AltoClef mod, BlockPos feet) {
        if (!mod.getChunkTracker().isChunkLoaded(feet)) return false;
        BlockPos floor = feet.down();
        BlockState support = mod.getWorld().getBlockState(floor);
        if (!support.isSolidBlock(mod.getWorld(), floor) || !support.getFluidState().isEmpty()
                || support.isOf(Blocks.MAGMA_BLOCK) || support.isOf(Blocks.CACTUS)
                || support.isOf(Blocks.CAMPFIRE) || support.isOf(Blocks.SOUL_CAMPFIRE)) return false;
        for (int dy = 0; dy < 2; dy++) {
            BlockPos body = feet.up(dy);
            BlockState state = mod.getWorld().getBlockState(body);
            if (!state.getCollisionShape(mod.getWorld(), body).isEmpty() || !state.getFluidState().isEmpty()
                    || state.isOf(Blocks.FIRE) || state.isOf(Blocks.SOUL_FIRE)) return false;
        }
        return true;
    }

    public static boolean hasRetreatMargin(AltoClef mod, BlockPos feet) {
        return hasMargin(mod, feet, 2);
    }

    public static boolean hasMargin(AltoClef mod, BlockPos feet, int margin) {
        return LocalSafetyPolicy.hasMargin((x, y, z) -> isSafeColumn(mod, new BlockPos(x, y, z)),
                feet.getX(), feet.getY(), feet.getZ(), margin);
    }

    public static Optional<BlockPos> findSafeAnchor(AltoClef mod, BlockPos origin, int radius,
                                                   Predicate<BlockPos> allowed) {
        return findSafeAnchor(mod, origin, radius, 2, allowed);
    }

    public static Optional<BlockPos> findSafeAnchor(AltoClef mod, BlockPos origin, int radius,
                                                   int margin, Predicate<BlockPos> allowed) {
        BlockPos best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        Vec3d player = mod.getPlayer().getPos();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -2; dy <= 2; dy++) {
                    BlockPos candidate = origin.add(dx, dy, dz);
                    double distance = player.squaredDistanceTo(candidate.getX() + 0.5, candidate.getY(), candidate.getZ() + 0.5);
                    if (distance < bestDistance && allowed.test(candidate) && hasMargin(mod, candidate, margin)) {
                        bestDistance = distance;
                        best = candidate;
                    }
                }
            }
        }
        return Optional.ofNullable(best);
    }
}
