export const THEME_PREFERENCE_VERSION = 1 as const;

export type ThemeId = "excalidraw";
export type ModePreference = "light" | "dark" | "system";
export type ResolvedColorScheme = "light" | "dark";

export interface ThemePreference {
  version: typeof THEME_PREFERENCE_VERSION;
  themeId: ThemeId;
  modePreference: ModePreference;
}

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolvedColorScheme: ResolvedColorScheme;
}

export interface ThemeFamily {
  id: ThemeId;
  displayName: string;
}
