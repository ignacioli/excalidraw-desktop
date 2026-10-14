import { afterEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn(async () => () => undefined);
const getCurrentWebviewWindow = vi.fn(() => ({ label: "window-2" }));

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow }));

const { defaultEventListener } = await import("./events");

afterEach(() => {
  listen.mockClear();
  getCurrentWebviewWindow.mockReset();
  getCurrentWebviewWindow.mockReturnValue({ label: "window-2" });
});

describe("defaultEventListener", () => {
  it("listens only for events sent to this window", async () => {
    const handler = vi.fn();

    await defaultEventListener("file-changed", handler);

    expect(listen).toHaveBeenCalledWith("file-changed", handler, {
      target: { kind: "WebviewWindow", label: "window-2" },
    });
  });

  it("listens without a target when there is no Tauri window", async () => {
    getCurrentWebviewWindow.mockImplementation(() => {
      throw new TypeError("no window metadata");
    });
    const handler = vi.fn();

    await defaultEventListener("file-changed", handler);

    expect(listen).toHaveBeenCalledWith("file-changed", handler, undefined);
  });
});
