package adris.altoclef.util.helpers;

public final class WitherDefensePolicy {
    public enum Choice { SHELTER, TOWER, FLEE }
    private WitherDefensePolicy() {}
    public static Choice choose(boolean shelter, boolean floor, boolean headroom, boolean ranged,
                                boolean otherClose, int blocks, double distance, float health, boolean wither) {
        if (wither || health <= 10 || ranged || otherClose) return Choice.FLEE;
        if (shelter) return Choice.SHELTER;
        if (floor && headroom && !ranged && !otherClose && blocks >= 3 && distance >= 7 && health >= 14)
            return Choice.TOWER;
        return Choice.FLEE;
    }
    public static double safeMeleeDistance(double enemyWidth, double playerWidth) {
        return Math.sqrt(enemyWidth * 2 * enemyWidth * 2 + playerWidth) + 0.15;
    }
}
