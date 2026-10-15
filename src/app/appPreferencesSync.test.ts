import { describe, expect, it, vi } from "vitest";
import type { TauriEventPayload } from "../ipc/events";
import {
  broadcastAppPreferences,
  followAppPreferences,
} from "./appPreferencesSync";

describe("app preference sync", () => {
  it("applies another window's change without broadcasting it again", async () => {
    let deliver:
      | ((event: TauriEventPayload<"app-preferences-changed">) => void)
      | undefined;
    const themeController = { applyExternalModePreference: vi.fn() };
    const localeController = { applyExternalPreference: vi.fn() };

    await followAppPreferences({
      themeController,
      localeController,
      listen: async (_name, handler) => {
        deliver = handler;
        return () => undefined;
      },
    });
    deliver?.({ payload: { appearance: "dark" } });
    deliver?.({ payload: { language: "zh-CN" } });

    expect(themeController.applyExternalModePreference).toHaveBeenCalledOnce();
    expect(themeController.applyExternalModePreference).toHaveBeenCalledWith(
      "dark",
    );
    expect(localeController.applyExternalPreference).toHaveBeenCalledOnce();
    expect(localeController.applyExternalPreference).toHaveBeenCalledWith(
      "zh-CN",
    );
  });

  it("keeps the local change when sharing it fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = vi.fn(async () => {
      throw new Error("no backend");
    });

    await expect(
      broadcastAppPreferences({ invoke }, { language: "en" }),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("app_preferences_broadcast", {
      language: "en",
    });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
