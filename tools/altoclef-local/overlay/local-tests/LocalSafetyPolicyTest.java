import adris.altoclef.util.helpers.LocalSafetyPolicy;
import adris.altoclef.util.helpers.InventoryCapacityPolicy;

public class LocalSafetyPolicyTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        check(LocalSafetyPolicy.hasRetreatMargin((x,y,z) -> true, 0,64,0), "Flat platform must allow combat");
        check(!LocalSafetyPolicy.hasRetreatMargin((x,y,z) -> x < 2, 0,64,0), "Ledge within knockback margin must be rejected");
        check(!LocalSafetyPolicy.hasRetreatMargin((x,y,z) -> !(x == -2 && z == 2), 0,64,0), "Diagonal lava/hole must be rejected");
        check(!LocalSafetyPolicy.hasRetreatMargin((x,y,z) -> false, 0,64,0), "Unknown terrain must be rejected");
        check(LocalSafetyPolicy.withinSpawnerRange(10,64,0,0,64,0), "Waiting point must keep spawner active");
        check(!LocalSafetyPolicy.withinSpawnerRange(10,74,0,0,64,0), "Vertical distance also counts");
        check(!LocalSafetyPolicy.withinSpawnerRange(16,64,0,0,64,0), "Distant waiting point must be rejected");
        check(InventoryCapacityPolicy.fitsStack(1,15,16), "Sixteenth pearl must fit");
        check(!InventoryCapacityPolicy.fitsStack(1,16,16), "Full pearl stack must require another slot");
        check(InventoryCapacityPolicy.fitsStack(4,12,16), "Exact fit of a dropped pearl stack must work");
        check(!InventoryCapacityPolicy.fitsStack(5,12,16), "Overflow must require another slot");
        System.out.println("11 safety and inventory checks passed");
    }
}
