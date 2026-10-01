package adris.altoclef.util.helpers;

public final class InventoryCapacityPolicy {
    private InventoryCapacityPolicy() {}
    public static boolean fitsStack(int incoming, int existing, int maxCount) {
        return incoming > 0 && existing >= 0 && existing <= maxCount && incoming <= maxCount - existing;
    }
}
