import type { ThemeFamily, ThemeId } from "./types";

const themeFamilies = {
  excalidraw: {
    id: "excalidraw",
    displayName: "Excalidraw",
  },
} satisfies Record<ThemeId, ThemeFamily>;

export const DEFAULT_THEME_ID: ThemeId = "excalidraw";

export function getThemeFamily(themeId: ThemeId): ThemeFamily {
  return themeFamilies[themeId];
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && value in themeFamilies;
}
