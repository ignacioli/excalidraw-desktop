import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import type { NativeMenuSyncState } from "../ipc/contracts";
import { createNativeMenuSync, nativeMenuLabels } from "./nativeMenuSync";

const state: NativeMenuSyncState = {
  language: "system",
  appearance: "system",
  hasDocument: true,
  forcedReadOnly: false,
  toolLock: false,
  grid: false,
  snap: false,
  zen: false,
  viewMode: false,
};

function recordingInvoker() {
  const invoke = vi.fn(async () => ({}));
  return { invoke, invoker: { invoke } as unknown as CommandInvoker };
}

describe("nativeMenuLabels", () => {
  it("localizes every label, including predefined item text", () => {
    const en = nativeMenuLabels("en");
    const zh = nativeMenuLabels("zh-CN");
    expect(Object.keys(en)).toHaveLength(41);
    expect(en["app.quit"]).toBe("Quit Excalidraw");
    expect(en["file.newWindow"]).toBe("New Window");
    expect(zh["file.openWorkspace"]).toBe("打开工作区…");
    expect(zh["app.quit"]).toBe("退出 Excalidraw");
    expect(zh["edit.undo"]).toBe("撤销");
    expect(zh["app.languageEn"]).toBe("English");
    expect(zh["app.languageEs"]).toBe("Español");
    expect(zh["app.languageJa"]).toBe("日本語");
    expect(en["app.languageEs"]).toBe("Español");
    expect(en["app.languageJa"]).toBe("日本語");
    for (const text of Object.values(zh)) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("createNativeMenuSync", () => {
  it("does not resend an identical snapshot", async () => {
    const { invoke, invoker } = recordingInvoker();
    const sync = createNativeMenuSync(invoker);

    await expect(sync("en", state)).resolves.toBe(true);
    await expect(sync("en", { ...state })).resolves.toBe(false);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("native_menu_sync", {
      labels: nativeMenuLabels("en"),
      state,
    });
  });

  it("sends the new label set when the language changes", async () => {
    const { invoke, invoker } = recordingInvoker();
    const sync = createNativeMenuSync(invoker);

    await sync("en", state);
    await sync("zh-CN", { ...state, language: "zh-CN" });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("native_menu_sync", {
      labels: nativeMenuLabels("zh-CN"),
      state: { ...state, language: "zh-CN" },
    });
  });

  it("retries a snapshot after a failed send", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue({});
    const sync = createNativeMenuSync({ invoke } as unknown as CommandInvoker);

    await expect(sync("en", state)).rejects.toThrow("busy");
    await expect(sync("en", state)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
