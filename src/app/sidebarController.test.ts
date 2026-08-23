import { describe, expect, it, vi } from "vitest";
import {
  createSidebarController,
  type SidebarHoldReason,
  type SidebarSnapshot,
} from "./sidebarController";

function expectSnapshot(
  snapshot: SidebarSnapshot,
  expected: {
    mode: SidebarSnapshot["mode"];
    closePending?: boolean;
    holds?: readonly SidebarHoldReason[];
  },
): void {
  expect(snapshot.mode).toBe(expected.mode);
  expect(snapshot.closePending).toBe(expected.closePending ?? false);
  expect([...snapshot.holdReasons].sort()).toEqual(
    [...(expected.holds ?? [])].sort(),
  );
}

describe("createSidebarController", () => {
  it("starts hidden with no closePending or holds when unpinned", () => {
    const controller = createSidebarController();

    expectSnapshot(controller.getSnapshot(), { mode: "hidden" });
  });

  it("starts pinned when initiallyPinned is true", () => {
    const controller = createSidebarController({ initiallyPinned: true });

    expectSnapshot(controller.getSnapshot(), { mode: "pinned" });
  });

  it("openOverlay transitions hidden to overlay and is a no-op when pinned", () => {
    const controller = createSidebarController();
    controller.openOverlay();
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });

    controller.openOverlay();
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });

    const pinned = createSidebarController({ initiallyPinned: true });
    pinned.openOverlay();
    expectSnapshot(pinned.getSnapshot(), { mode: "pinned" });
  });

  it("pin and unpin move overlay or hidden to pinned, then back to overlay", () => {
    const fromHidden = createSidebarController();
    fromHidden.pin();
    expectSnapshot(fromHidden.getSnapshot(), { mode: "pinned" });

    const controller = createSidebarController();
    controller.openOverlay();
    controller.pin();
    expectSnapshot(controller.getSnapshot(), { mode: "pinned" });

    controller.unpin();
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });

    controller.unpin();
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });
  });

  it("hide closes overlay and closePending but not a pinned sidebar", () => {
    const overlay = createSidebarController();
    overlay.openOverlay();
    overlay.hide();
    expectSnapshot(overlay.getSnapshot(), { mode: "hidden" });

    const pending = createSidebarController({ now: () => 0 });
    pending.openOverlay();
    pending.handlePointerLeave();
    expect(pending.getSnapshot().closePending).toBe(true);
    pending.hide();
    expectSnapshot(pending.getSnapshot(), { mode: "hidden" });

    const pinned = createSidebarController({ initiallyPinned: true });
    pinned.hide();
    expectSnapshot(pinned.getSnapshot(), { mode: "pinned" });

    pinned.unpin();
    pinned.hide();
    expectSnapshot(pinned.getSnapshot(), { mode: "hidden" });
  });

  it("handleEscape closes overlay, cancels closePending, and reports whether it handled", () => {
    const hidden = createSidebarController();
    expect(hidden.handleEscape()).toBe(false);
    expectSnapshot(hidden.getSnapshot(), { mode: "hidden" });

    const pinned = createSidebarController({ initiallyPinned: true });
    expect(pinned.handleEscape()).toBe(false);
    expectSnapshot(pinned.getSnapshot(), { mode: "pinned" });

    const overlay = createSidebarController();
    overlay.openOverlay();
    overlay.setHold("focus", true);
    expect(overlay.handleEscape()).toBe(true);
    expect(overlay.getSnapshot().mode).toBe("hidden");
    expect(overlay.getSnapshot().closePending).toBe(false);
    expect(overlay.handleEscape()).toBe(false);

    const pending = createSidebarController({ now: () => 0 });
    pending.openOverlay();
    pending.handlePointerLeave();
    expect(pending.handleEscape()).toBe(true);
    expectSnapshot(pending.getSnapshot(), { mode: "hidden" });
  });

  it("pointer leave starts closePending and tick hides after 500ms when holds are empty", () => {
    let now = 1_000;
    const controller = createSidebarController({ now: () => now });
    controller.openOverlay();
    controller.handlePointerLeave();
    expectSnapshot(controller.getSnapshot(), {
      mode: "overlay",
      closePending: true,
    });
    expect(controller.getSnapshot().hideAtMs).toBe(1_500);

    controller.tick(1_499);
    expectSnapshot(controller.getSnapshot(), {
      mode: "overlay",
      closePending: true,
    });

    now = 1_500;
    controller.tick(now);
    expectSnapshot(controller.getSnapshot(), { mode: "hidden" });
  });

  it("defaults the pointer-leave delay to 500ms and honors pointerLeaveDelayMs", () => {
    let now = 0;
    const custom = createSidebarController({
      now: () => now,
      pointerLeaveDelayMs: 200,
    });
    custom.openOverlay();
    custom.handlePointerLeave();
    custom.tick(199);
    expectSnapshot(custom.getSnapshot(), {
      mode: "overlay",
      closePending: true,
    });
    now = 200;
    custom.tick(now);
    expectSnapshot(custom.getSnapshot(), { mode: "hidden" });
  });

  it("re-entering during the delay cancels closePending", () => {
    let now = 0;
    const controller = createSidebarController({ now: () => now });
    controller.openOverlay();
    controller.handlePointerLeave();
    now = 400;
    controller.tick(now);
    controller.handlePointerEnter();
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });

    now = 500;
    controller.tick(now);
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });

    controller.handlePointerLeave();
    now = 900;
    controller.tick(now);
    expectSnapshot(controller.getSnapshot(), {
      mode: "overlay",
      closePending: true,
    });
    now = 1_000;
    controller.tick(now);
    expectSnapshot(controller.getSnapshot(), { mode: "hidden" });
  });

  it.each(["focus", "menu", "dialog", "drag"] as const)(
    "pauses overlay auto-close while the %s hold is active",
    (reason) => {
      let now = 0;
      const controller = createSidebarController({ now: () => now });
      controller.openOverlay();
      controller.setHold(reason, true);
      controller.handlePointerLeave();
      expectSnapshot(controller.getSnapshot(), {
        mode: "overlay",
        holds: [reason],
      });

      now = 500;
      controller.tick(now);
      expectSnapshot(controller.getSnapshot(), {
        mode: "overlay",
        holds: [reason],
      });

      controller.setHold(reason, false);
      expectSnapshot(controller.getSnapshot(), {
        mode: "overlay",
        closePending: true,
      });
      now = 1_000;
      controller.tick(now);
      expectSnapshot(controller.getSnapshot(), { mode: "hidden" });
    },
  );

  it("re-enter or hold during closePending returns to overlay and does not hide at 500ms", () => {
    let now = 0;
    const reenter = createSidebarController({ now: () => now });
    reenter.openOverlay();
    reenter.handlePointerLeave();
    reenter.setHold("dialog", true);
    expectSnapshot(reenter.getSnapshot(), {
      mode: "overlay",
      holds: ["dialog"],
    });
    now = 500;
    reenter.tick(now);
    expectSnapshot(reenter.getSnapshot(), {
      mode: "overlay",
      holds: ["dialog"],
    });

    now = 0;
    const stacked = createSidebarController({ now: () => now });
    stacked.openOverlay();
    stacked.setHold("menu", true);
    stacked.setHold("drag", true);
    stacked.handlePointerLeave();
    stacked.setHold("menu", false);
    expectSnapshot(stacked.getSnapshot(), {
      mode: "overlay",
      holds: ["drag"],
    });
    now = 500;
    stacked.tick(now);
    expectSnapshot(stacked.getSnapshot(), {
      mode: "overlay",
      holds: ["drag"],
    });
  });

  it("ignores pointer leave, tick, and openOverlay while pinned", () => {
    let now = 0;
    const controller = createSidebarController({
      initiallyPinned: true,
      now: () => now,
    });
    controller.handlePointerLeave();
    now = 500;
    controller.tick(now);
    controller.openOverlay();
    expectSnapshot(controller.getSnapshot(), { mode: "pinned" });
  });

  it("notifies subscribers until they unsubscribe", () => {
    const controller = createSidebarController();
    const listenerSnapshots: SidebarSnapshot[] = [];
    const listener = vi.fn(() => {
      listenerSnapshots.push(controller.getSnapshot());
    });

    const unsubscribe = controller.subscribe(listener);
    controller.openOverlay();
    controller.pin();
    expect(listener).toHaveBeenCalled();
    expect(listenerSnapshots.at(-1)?.mode).toBe("pinned");

    const callsAfterPin = listener.mock.calls.length;
    unsubscribe();
    controller.unpin();
    expect(listener).toHaveBeenCalledTimes(callsAfterPin);
    expectSnapshot(controller.getSnapshot(), { mode: "overlay" });
  });
});
