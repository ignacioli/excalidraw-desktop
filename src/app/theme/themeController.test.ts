import { describe, expect, it } from "vitest";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_VERSION,
  ThemeController,
} from "./themeController";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class ColorSchemeMedia {
  matches: boolean;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(
    _type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean) {
    this.matches = matches;
    const event = { matches } as MediaQueryListEvent;
    this.listeners.forEach((listener) => listener(event));
  }
}

function preference(modePreference: "light" | "dark" | "system") {
  return JSON.stringify({
    version: THEME_PREFERENCE_VERSION,
    themeId: "excalidraw",
    modePreference,
  });
}

function createController(options?: { stored?: string; systemDark?: boolean }) {
  const storage = new MemoryStorage();
  const media = new ColorSchemeMedia(options?.systemDark ?? false);
  const root = document.createElement("html");

  if (options?.stored !== undefined) {
    storage.values.set(THEME_PREFERENCE_STORAGE_KEY, options.stored);
  }

  return {
    controller: new ThemeController({ storage, colorSchemeMedia: media, root }),
    media,
    root,
    storage,
  };
}

describe("ThemeController", () => {
  it.each([
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)(
    "resolves %s preference against systemDark=%s",
    (mode, systemDark, expected) => {
      const { controller, root } = createController({
        stored: preference(mode),
        systemDark,
      });

      expect(controller.getSnapshot()).toEqual({
        preference: {
          version: THEME_PREFERENCE_VERSION,
          themeId: "excalidraw",
          modePreference: mode,
        },
        resolvedColorScheme: expected,
      });
      expect(root.dataset.colorScheme).toBe(expected);
    },
  );

  it("tracks runtime system changes while following the system", () => {
    const { controller, media, root } = createController({ systemDark: false });
    let updates = 0;
    controller.subscribe(() => {
      updates += 1;
    });

    media.setMatches(true);

    expect(controller.getSnapshot().resolvedColorScheme).toBe("dark");
    expect(root.dataset.colorScheme).toBe("dark");
    expect(updates).toBe(1);
  });

  it("ignores runtime system changes in a manual mode", () => {
    const { controller, media } = createController({
      stored: preference("light"),
      systemDark: false,
    });

    media.setMatches(true);

    expect(controller.getSnapshot().resolvedColorScheme).toBe("light");
  });

  it("restores a versioned preference", () => {
    const { controller } = createController({ stored: preference("dark") });

    expect(controller.getSnapshot().preference.modePreference).toBe("dark");
  });

  it.each([
    "not-json",
    JSON.stringify({
      version: 2,
      themeId: "excalidraw",
      modePreference: "dark",
    }),
    JSON.stringify({ version: 1, themeId: "unknown", modePreference: "dark" }),
    JSON.stringify({
      version: 1,
      themeId: "excalidraw",
      modePreference: "sepia",
    }),
  ])(
    "falls back safely when the stored preference is invalid: %s",
    (stored) => {
      const { controller, storage } = createController({
        stored,
        systemDark: true,
      });

      expect(controller.getSnapshot()).toEqual({
        preference: {
          version: THEME_PREFERENCE_VERSION,
          themeId: "excalidraw",
          modePreference: "system",
        },
        resolvedColorScheme: "dark",
      });
      expect(storage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe(
        preference("system"),
      );
    },
  );
});
