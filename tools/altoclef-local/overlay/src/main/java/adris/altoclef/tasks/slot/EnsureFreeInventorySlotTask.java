package adris.altoclef.tasks.slot;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.helpers.ItemHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.slots.Slot;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.slot.SlotActionType;

import java.util.Optional;

public class EnsureFreeInventorySlotTask extends Task {
    @Override
    protected void onStart() {

    }

    @Override
    protected Task onTick() {
        AltoClef mod = AltoClef.getInstance();

        ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
        Optional<Slot> garbage = StorageHelper.getGarbageSlot(mod);
        if (cursorStack.isEmpty()) {
            if (garbage.isPresent()) {
                mod.getSlotHandler().clickSlot(garbage.get(), 0, SlotActionType.PICKUP);
                return null;
            }
        }
        if (!cursorStack.isEmpty()) {
            if (!ItemHelper.canThrowAwayStack(mod, cursorStack)) {
                Optional<Slot> storage = mod.getItemStorage().getSlotThatCanFitInPlayerInventory(cursorStack, false);
                if (storage.isPresent()) {
                    mod.getSlotHandler().clickSlot(storage.get(), 0, SlotActionType.PICKUP);
                    return null;
                }
                if (garbage.isPresent()) {
                    // Store the protected cursor item, then discard only the displaced expendable stack.
                    mod.getSlotHandler().clickSlot(garbage.get(), 0, SlotActionType.PICKUP);
                    return null;
                }
                setDebugState("Objet protege sur le curseur : je ne le jette pas.");
                return null;
            }
            // Throw toward the ground, without randomly looking into an enderman's eyes.
            LookHelper.lookAt(mod, mod.getPlayer().getPos().add(2, -1, 0));
            mod.getSlotHandler().clickSlot(Slot.UNDEFINED, 0, SlotActionType.PICKUP);
            return null;
        }
        setDebugState("All items are protected.");
        return null;
    }

    @Override
    protected void onStop(Task interruptTask) {

    }

    @Override
    protected boolean isEqual(Task obj) {
        return obj instanceof EnsureFreeInventorySlotTask;
    }

    @Override
    protected String toDebugString() {
        return "Ensuring inventory is free";
    }
}
