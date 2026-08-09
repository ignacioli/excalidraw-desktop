import { DEFAULT_THEME_ID, isThemeId } from "./themeRegistry";
import {
  THEME_PREFERENCE_VERSION,
  type ModePreference,
  type ResolvedColorScheme,
  type ThemePreference,
  type ThemeSnapshot,
} from "./types";

export { THEME_PREFERENCE_VERSION } from "./types";

export const THEME_PREFERENCE_STORAGE_KEY = "excalidraw-desktop.appearance";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
interface ColorSchemeMedia {
  readonly matches: boolean;
  addEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void;
  removeEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void;
}

interface ThemeControllerOptions {
  storage: ThemeStorage;
  colorSchemeMedia: ColorSchemeMedia;
  root: HTMLElement;
}

const defaultPreference = (): ThemePreference => ({
  version: THEME_PREFERENCE_VERSION,
  themeId: DEFAULT_THEME_ID,
  modePreference: "system",
});

function isModePreference(value: unknown): value is ModePreference {
  return value === "light" || value === "dark" || value === "system";
}

function isThemePreference(value: unknown): value is ThemePreference {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Record<keyof ThemePreference, unknown>>;
  return (
    candidate.version === THEME_PREFERENCE_VERSION &&
    isThemeId(candidate.themeId) &&
    isModePreference(candidate.modePreference)
  );
}

function resolveColorScheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedColorScheme {
  if (preference.modePreference === "system") {
    return systemDark ? "dark" : "light";
  }

  return preference.modePreference;
}

export class ThemeController {
  private readonly storage: ThemeStorage;
  private readonly colorSchemeMedia: ColorSchemeMedia;
  private readonly root: HTMLElement;
  private readonly listeners = new Set<() => void>();
  private snapshot: ThemeSnapshot;

  constructor({ storage, colorSchemeMedia, root }: ThemeControllerOptions) {
    this.storage = storage;
    this.colorSchemeMedia = colorSchemeMedia;
    this.root = root;

    const preference = this.restorePreference();
    this.snapshot = {
      preference,
      resolvedColorScheme: resolveColorScheme(
        preference,
        colorSchemeMedia.matches,
      ),
    };

    this.applySnapshot();
    this.colorSchemeMedia.addEventListener("change", this.handleSystemChange);
  }

  getSnapshot = (): ThemeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setModePreference(modePreference: ModePreference): void {
    const preference: ThemePreference = {
      ...this.snapshot.preference,
      modePreference,
    };
    this.storage.setItem(
      THEME_PREFERENCE_STORAGE_KEY,
      JSON.stringify(preference),
    );
    this.update(preference);
  }

  dispose(): void {
    this.colorSchemeMedia.removeEventListener(
      "change",
      this.handleSystemChange,
    );
    this.listeners.clear();
  }

  private readonly handleSystemChange = (): void => {
    if (this.snapshot.preference.modePreference === "system") {
      this.update(this.snapshot.preference);
    }
  };

  private restorePreference(): ThemePreference {
    const stored = this.storage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (isThemePreference(parsed)) {
          return parsed;
        }
      } catch {
        // Malformed local preferences are replaced with the safe default below.
      }
    }

    const fallback = defaultPreference();
    this.storage.setItem(
      THEME_PREFERENCE_STORAGE_KEY,
      JSON.stringify(fallback),
    );
    return fallback;
  }

  private update(preference: ThemePreference): void {
    const nextSnapshot: ThemeSnapshot = {
      preference,
      resolvedColorScheme: resolveColorScheme(
        preference,
        this.colorSchemeMedia.matches,
      ),
    };

    if (
      nextSnapshot.preference === this.snapshot.preference &&
      nextSnapshot.resolvedColorScheme === this.snapshot.resolvedColorScheme
    ) {
      return;
    }

    this.snapshot = nextSnapshot;
    this.applySnapshot();
    this.listeners.forEach((listener) => listener());
  }

  private applySnapshot(): void {
    this.root.dataset.theme = this.snapshot.preference.themeId;
    this.root.dataset.colorScheme = this.snapshot.resolvedColorScheme;
    this.root.style.colorScheme = this.snapshot.resolvedColorScheme;
  }
}

let browserThemeController: ThemeController | undefined;
const fallbackBrowserStorage = new Map<string, string>();

function getBrowserThemeStorage(): ThemeStorage {
  try {
    if (window.localStorage !== undefined) {
      return window.localStorage;
    }
  } catch {
    // Some embedded/test origins intentionally disable localStorage.
  }

  return {
    getItem: (key) => fallbackBrowserStorage.get(key) ?? null,
    setItem: (key, value) => {
      fallbackBrowserStorage.set(key, value);
    },
  };
}

export function initializeBrowserThemeController(): ThemeController {
  browserThemeController ??= new ThemeController({
    storage: getBrowserThemeStorage(),
    colorSchemeMedia:
      typeof window.matchMedia === "function"
        ? window.matchMedia(SYSTEM_DARK_QUERY)
        : {
            matches: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
    root: document.documentElement,
  });
  return browserThemeController;
}

export function getBrowserThemeController(): ThemeController {
  if (browserThemeController === undefined) {
    throw new Error("Theme controller has not been initialized");
  }
  return browserThemeController;
}
