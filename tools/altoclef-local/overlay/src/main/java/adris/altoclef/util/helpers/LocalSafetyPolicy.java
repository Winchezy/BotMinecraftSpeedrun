package adris.altoclef.util.helpers;

/** Pure terrain checks, shared by combat and spawner waiting. */
public final class LocalSafetyPolicy {
    private LocalSafetyPolicy() {}

    public interface Ground {
        boolean safeColumn(int x, int y, int z);
    }

    public static boolean hasRetreatMargin(Ground ground, int x, int y, int z) {
        return hasMargin(ground, x, y, z, 2);
    }

    public static boolean hasMargin(Ground ground, int x, int y, int z, int margin) {
        for (int dx = -margin; dx <= margin; dx++) {
            for (int dz = -margin; dz <= margin; dz++) {
                if (!ground.safeColumn(x + dx, y, z + dz)) return false;
            }
        }
        return true;
    }

    public static boolean withinSpawnerRange(int x, int y, int z, int sx, int sy, int sz) {
        double dx = x + 0.5 - (sx + 0.5);
        double dy = y - (sy + 0.5);
        double dz = z + 0.5 - (sz + 0.5);
        return dx * dx + dy * dy + dz * dz <= 12 * 12;
    }
}
