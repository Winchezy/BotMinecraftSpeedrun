import adris.altoclef.util.helpers.WitherDefensePolicy;
import static adris.altoclef.util.helpers.WitherDefensePolicy.Choice.*;

public class WitherDefensePolicyTest {
    private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    public static void main(String[] args) {
        check(WitherDefensePolicy.choose(true,true,true,false,false,3,8,20,false) == SHELTER, "Shelter must have priority");
        check(WitherDefensePolicy.choose(false,true,true,false,false,3,8,20,false) == TOWER, "Clear stable terrain may allow a tower");
        check(WitherDefensePolicy.choose(false,false,true,false,false,3,8,20,false) == FLEE, "No tower at a ledge");
        check(WitherDefensePolicy.choose(false,true,false,false,false,3,8,20,false) == FLEE, "No tower without headroom");
        check(WitherDefensePolicy.choose(false,true,true,true,false,3,8,20,false) == FLEE, "No tower with a ranged threat");
        check(WitherDefensePolicy.choose(true,true,true,false,true,3,8,20,false) == FLEE, "A second close hostile invalidates the plan");
        check(WitherDefensePolicy.choose(false,true,true,false,false,2,8,20,false) == FLEE, "Do not start with insufficient materials");
        check(WitherDefensePolicy.choose(false,true,true,false,false,3,3,20,false) == FLEE, "Do not tower with enemy already in contact");
        check(WitherDefensePolicy.choose(false,true,true,false,false,3,8,12,false) == FLEE, "Low health must forbid construction");
        check(WitherDefensePolicy.choose(true,true,true,false,false,3,8,20,true) == FLEE, "Wither effect must force retreat");
        check(WitherDefensePolicy.safeMeleeDistance(0.7,0.6) > 1.6 && WitherDefensePolicy.safeMeleeDistance(0.7,0.6) < 1.8, "Stay beyond vanilla melee range");
        System.out.println("11 Wither defense checks passed");
    }
}
