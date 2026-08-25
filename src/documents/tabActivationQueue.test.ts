import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestWheel,
  inFlightTargetId,
  pendingLatestId,
  requestActivate,
  resetTabActivationQueue,
} from "./tabActivationQueue";

describe("tabActivationQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTabActivationQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps one unmodified vertical notch to one wrapped step and ignores horizontal or modified input", () => {
    expect(
      ingestWheel({
        deltaX: 0,
        deltaY: 120,
        deltaMode: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 4,
        activeIndex: 0,
      }),
    ).toBe(1);
    expect(
      ingestWheel({
        deltaX: 0,
        deltaY: -120,
        deltaMode: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 4,
        activeIndex: 0,
      }),
    ).toBe(3);
    expect(
      ingestWheel({
        deltaX: 80,
        deltaY: 10,
        deltaMode: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 4,
        activeIndex: 1,
      }),
    ).toBeNull();
    expect(
      ingestWheel({
        deltaX: 0,
        deltaY: 120,
        deltaMode: 0,
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 4,
        activeIndex: 1,
      }),
    ).toBeNull();
  });

  it("cools down so one physical notch cannot skip multiple tabs", () => {
    expect(
      ingestWheel({
        deltaX: 0,
        deltaY: 800,
        deltaMode: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 5,
        activeIndex: 2,
      }),
    ).toBe(3);
    expect(
      ingestWheel({
        deltaX: 0,
        deltaY: 120,
        deltaMode: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        tabCount: 5,
        activeIndex: 3,
      }),
    ).toBeNull();
  });

  it("keeps only the latest pending id while an activation is in flight", async () => {
    void requestActivate("a");
    await Promise.resolve();
    expect(inFlightTargetId).toBe("a");
    void requestActivate("b");
    void requestActivate("c");
    expect(pendingLatestId).toBe("c");
  });
});
