import {
  resolveLanguage,
  type LanguagePreference,
  type ResolvedLanguage,
} from "./resolveLanguage";

export const LANGUAGE_PREFERENCE_STORAGE_KEY = "excalidraw-desktop.language";
export const LANGUAGE_PREFERENCE_VERSION = 1 as const;

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

export interface LocaleSnapshot {
  readonly preference: LanguagePreference;
  readonly resolvedLanguage: ResolvedLanguage;
}

interface LocaleControllerOptions {
  storage: LocaleStorage;
  /** System languages read once at startup (handshake); never re-read. */
  preferredLanguages: readonly string[];
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return (
    value === "system" ||
    value === "en" ||
    value === "zh-CN" ||
    value === "es" ||
    value === "ja"
  );
}

export class LocaleController {
  private readonly storage: LocaleStorage;
  private readonly preferredLanguages: readonly string[];
  private readonly listeners = new Set<() => void>();
  private snapshot: LocaleSnapshot;

  constructor({ storage, preferredLanguages }: LocaleControllerOptions) {
    this.storage = storage;
    this.preferredLanguages = [...preferredLanguages];
    this.snapshot = this.snapshotFor(this.restorePreference());
  }

  getSnapshot = (): LocaleSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setPreference(preference: LanguagePreference): void {
    try {
      this.storage.setItem(
        LANGUAGE_PREFERENCE_STORAGE_KEY,
        JSON.stringify({ version: LANGUAGE_PREFERENCE_VERSION, preference }),
      );
    } catch (error) {
      // The switch still applies to this session; only persistence is lost.
      console.error("Failed to persist the language preference.", error);
    }
    if (preference === this.snapshot.preference) return;
    this.snapshot = this.snapshotFor(preference);
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Apply a language chosen in another window. That window stored it, so
   * this one neither stores nor broadcasts it again. Invalid values are
   * ignored.
   */
  applyExternalPreference(preference: unknown): void {
    if (!isLanguagePreference(preference)) return;
    if (preference === this.snapshot.preference) return;
    this.snapshot = this.snapshotFor(preference);
    this.listeners.forEach((listener) => listener());
  }

  private snapshotFor(preference: LanguagePreference): LocaleSnapshot {
    return {
      preference,
      resolvedLanguage: resolveLanguage(preference, this.preferredLanguages),
    };
  }

  private restorePreference(): LanguagePreference {
    try {
      const stored = this.storage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
      if (stored === null) return "system";
      const parsed: unknown = JSON.parse(stored);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        parsed.version === LANGUAGE_PREFERENCE_VERSION &&
        "preference" in parsed &&
        isLanguagePreference(parsed.preference)
      ) {
        return parsed.preference;
      }
    } catch {
      // Unreadable or malformed local preferences fall back to the system.
    }
    return "system";
  }
}
