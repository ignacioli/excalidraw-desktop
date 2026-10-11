import { useSyncExternalStore } from "react";
import { LocaleController, type LocaleSnapshot } from "./localeController";
import { en, type MessageKey } from "./messages/en.ts";
import { zhCN } from "./messages/zh-CN.ts";
import type { ResolvedLanguage } from "./resolveLanguage";

export { LocaleController, type LocaleSnapshot } from "./localeController";
export type { MessageKey } from "./messages/en.ts";
export {
  resolveLanguage,
  type LanguagePreference,
  type ResolvedLanguage,
} from "./resolveLanguage";

export type MessageParams = Readonly<Record<string, string | number>>;

const catalogs: Readonly<
  Record<ResolvedLanguage, Readonly<Record<MessageKey, string>>>
> = { en, "zh-CN": zhCN };

/** Look up and interpolate one message in an explicit language. */
export function translate(
  language: ResolvedLanguage,
  key: MessageKey,
  params?: MessageParams,
): string {
  // A missing translation falls back to English entry by entry.
  const message = catalogs[language][key] || en[key];
  return message.replace(/\{(\w+)\}/gu, (placeholder, name: string) => {
    const value = params?.[name];
    if (value !== undefined) return String(value);
    if (import.meta.env.DEV) {
      throw new Error(`Missing message parameter "${name}" for ${key}`);
    }
    return placeholder;
  });
}

export function formatDateTimeIn(
  language: ResolvedLanguage,
  date: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(language, options).format(date);
}

let browserLocaleController: LocaleController | undefined;
const fallbackBrowserStorage = new Map<string, string>();

function getBrowserLocaleStorage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    if (window.localStorage !== undefined) return window.localStorage;
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

export function initializeBrowserLocaleController(
  preferredLanguages: readonly string[],
): LocaleController {
  if (browserLocaleController !== undefined) return browserLocaleController;
  const controller = new LocaleController({
    storage: getBrowserLocaleStorage(),
    preferredLanguages,
  });
  const applyDocumentLanguage = () => {
    document.documentElement.lang = controller.getSnapshot().resolvedLanguage;
  };
  applyDocumentLanguage();
  controller.subscribe(applyDocumentLanguage);
  browserLocaleController = controller;
  return controller;
}

export function getBrowserLocaleController(): LocaleController {
  if (browserLocaleController === undefined) {
    throw new Error("Locale controller has not been initialized");
  }
  return browserLocaleController;
}

const ENGLISH_SNAPSHOT: LocaleSnapshot = {
  preference: "system",
  resolvedLanguage: "en",
};

function currentSnapshot(): LocaleSnapshot {
  return browserLocaleController?.getSnapshot() ?? ENGLISH_SNAPSHOT;
}

/** Translate in the current UI language (English before initialization). */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(currentSnapshot().resolvedLanguage, key, params);
}

export function formatDateTime(
  date: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatDateTimeIn(currentSnapshot().resolvedLanguage, date, options);
}

const subscribeToBrowserLocale = (listener: () => void): (() => void) =>
  browserLocaleController?.subscribe(listener) ?? (() => undefined);

export interface I18n extends LocaleSnapshot {
  t(key: MessageKey, params?: MessageParams): string;
  formatDateTime(
    date: Date | number,
    options?: Intl.DateTimeFormatOptions,
  ): string;
}

export function useI18n(): I18n {
  const snapshot = useSyncExternalStore(
    subscribeToBrowserLocale,
    currentSnapshot,
  );
  const language = snapshot.resolvedLanguage;
  return {
    ...snapshot,
    t: (key, params) => translate(language, key, params),
    formatDateTime: (date, options) =>
      formatDateTimeIn(language, date, options),
  };
}
