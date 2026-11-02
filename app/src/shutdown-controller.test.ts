import { describe, expect, it, vi } from "vitest";
import { ShutdownController } from "../electron/shutdown-controller";

const dirtyState = {
  hasUnsavedChanges: true,
  message: "Unsaved changes",
  cancelLabel: "Cancel",
  exitLabel: "Exit",
};

describe("ShutdownController", () => {
  it("preserves unsaved edits when the close confirmation is cancelled", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const exit = vi.fn();
    const controller = new ShutdownController(confirm, exit);
    controller.update(dirtyState);
    await controller.request();
    expect(exit).not.toHaveBeenCalled();
    await controller.request();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("exits without renderer cooperation after the project is saved", async () => {
    const confirm = vi.fn();
    const exit = vi.fn();
    const controller = new ShutdownController(confirm, exit);
    controller.update(dirtyState);
    controller.update({ ...dirtyState, hasUnsavedChanges: false });
    await controller.request();
    expect(confirm).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("shows one confirmation for simultaneous quit and window-close requests", async () => {
    let answer!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const exit = vi.fn();
    const controller = new ShutdownController(confirm, exit);
    controller.update(dirtyState);
    const firstRequest = controller.request();
    await controller.request();
    expect(confirm).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    answer(true);
    await firstRequest;
    await controller.request();
    expect(exit).toHaveBeenCalledOnce();
  });
});
