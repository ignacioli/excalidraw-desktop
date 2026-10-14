import { describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_PREFERENCE_STORAGE_KEY,
  LocaleController,
} from "./localeController";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(LANGUAGE_PREFERENCE_STORAGE_KEY, initial);
  }
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("LocaleController", () => {
  it("uses the storage key and versioned record", () => {
    const storage = memoryStorage();
    const controller = new LocaleController({
      storage,
      preferredLanguages: [],
    });

    controller.setPreference("zh-CN");

    expect(
      JSON.parse(storage.values.get("excalidraw-desktop.language") ?? ""),
    ).toEqual({ version: 1, preference: "zh-CN" });
  });

  it("applies another window's language without storing it", () => {
    const stored = JSON.stringify({ version: 1, preference: "en" });
    const storage = memoryStorage(stored);
    const controller = new LocaleController({
      storage,
      preferredLanguages: [],
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.applyExternalPreference("zh-CN");
    controller.applyExternalPreference("fr");

    expect(controller.getSnapshot()).toEqual({
      preference: "zh-CN",
      resolvedLanguage: "zh-CN",
    });
    expect(storage.values.get(LANGUAGE_PREFERENCE_STORAGE_KEY)).toBe(stored);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("restores a valid stored preference", () => {
    const controller = new LocaleController({
      storage: memoryStorage(JSON.stringify({ version: 1, preference: "en" })),
      preferredLanguages: ["zh-Hans-CN"],
    });

    expect(controller.getSnapshot()).toEqual({
      preference: "en",
      resolvedLanguage: "en",
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a future version", JSON.stringify({ version: 2, preference: "en" })],
    ["an unknown value", JSON.stringify({ version: 1, preference: "fr" })],
    ["a non-object", JSON.stringify("en")],
  ])("falls back to the system preference for %s", (_label, stored) => {
    const controller = new LocaleController({
      storage: memoryStorage(stored),
      preferredLanguages: ["zh-Hans-CN"],
    });

    expect(controller.getSnapshot()).toEqual({
      preference: "system",
      resolvedLanguage: "zh-CN",
    });
  });

  it("falls back to the system preference when reading throws", () => {
    const controller = new LocaleController({
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => undefined,
      },
      preferredLanguages: [],
    });

    expect(controller.getSnapshot().preference).toBe("system");
  });

  it("still switches this session when writing fails", () => {
    const controller = new LocaleController({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
      preferredLanguages: [],
    });

    controller.setPreference("zh-CN");

    expect(controller.getSnapshot()).toEqual({
      preference: "zh-CN",
      resolvedLanguage: "zh-CN",
    });
  });

  it("notifies subscribers with the new snapshot and stops after unsubscribe", () => {
    const controller = new LocaleController({
      storage: memoryStorage(),
      preferredLanguages: ["en-US"],
    });
    const seen: string[] = [];
    const listener = vi.fn(() => {
      seen.push(controller.getSnapshot().resolvedLanguage);
    });
    const unsubscribe = controller.subscribe(listener);

    controller.setPreference("zh-CN");
    controller.setPreference("zh-CN");
    unsubscribe();
    controller.setPreference("en");

    expect(seen).toEqual(["zh-CN"]);
  });
});
