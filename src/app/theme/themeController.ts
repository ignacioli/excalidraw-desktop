import { DEFAULT_THEME_ID, isThemeId } from "./themeRegistry";
import hf2Tokens from "../../../docs/design/desktop-shell/hf-2/tokens.json";
import {
  THEME_PREFERENCE_VERSION,
  type ModePreference,
  type ResolvedColorScheme,
  type ThemePreference,
  type ThemeSnapshot,
} from "./types";

export { THEME_PREFERENCE_VERSION } from "./types";

export const THEME_PREFERENCE_STORAGE_KEY = "excalidraw-desktop.appearance";
export const HF2_FONT_DEVIATION_ID = "HF2-FONT-001";
export const HF2_NATIVE_UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const HF2_NATIVE_MONO_FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, monospace";
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
    applyHf2Tokens(this.root, this.snapshot.resolvedColorScheme);
  }
}

const semanticVariableNames: Readonly<Record<string, string>> = {
  "color.app.background": "--app-background",
  "color.canvas.background": "--canvas-background",
  "color.panel.background": "--panel-background",
  "color.surface.background": "--surface-background",
  "color.surface.hover": "--surface-hover",
  "color.surface.active": "--surface-active",
  "color.text.primary": "--text-primary",
  "color.text.secondary": "--text-secondary",
  "color.text.disabled": "--text-disabled",
  "color.border.subtle": "--border-subtle",
  "color.border.strong": "--border-strong",
  "color.accent.base": "--accent",
  "color.accent.hover": "--accent-hover",
  "color.accent.contrast": "--accent-contrast",
  "color.focus.ring": "--focus-ring",
  "color.status.danger": "--danger",
  "color.status.warning": "--warning",
  "color.status.success": "--success",
};

function applyHf2Tokens(
  root: HTMLElement,
  colorScheme: ResolvedColorScheme,
): void {
  const semanticTokens = hf2Tokens.semantics[colorScheme];
  for (const [tokenName, variableName] of Object.entries(
    semanticVariableNames,
  )) {
    const token = semanticTokens[tokenName as keyof typeof semanticTokens];
    if (
      token !== undefined &&
      "value" in token &&
      typeof token.value === "string"
    ) {
      root.style.setProperty(variableName, token.value);
    }
  }

  const primitives = hf2Tokens.primitives;
  const typographyVariables: Readonly<Record<string, string>> = {
    "font.size.micro": "--font-size-micro",
    "font.size.label": "--font-size-label",
    "font.size.body": "--font-size-body",
    "font.size.section": "--font-size-section",
    "font.size.title": "--font-size-title",
    "font.weight.regular": "--font-weight-regular",
    "font.weight.medium": "--font-weight-medium",
    "font.weight.semibold": "--font-weight-semibold",
  };
  for (const [tokenName, variableName] of Object.entries(typographyVariables)) {
    const token = primitives[tokenName as keyof typeof primitives];
    if (token !== undefined && "value" in token) {
      root.style.setProperty(
        variableName,
        `${token.value}${"unit" in token ? token.unit : ""}`,
      );
    }
  }
  root.style.setProperty("--font-ui", HF2_NATIVE_UI_FONT_STACK);
  root.style.setProperty("--font-mono", HF2_NATIVE_MONO_FONT_STACK);
  root.style.setProperty("--line-height-body", "1.4");
  root.style.setProperty("--line-height-row", "28px");

  const primitiveVariables: Readonly<Record<string, string>> = {
    "space.1": "--space-1",
    "space.2": "--space-2",
    "space.3": "--space-3",
    "space.4": "--space-4",
    "space.6": "--space-6",
    "radius.control": "--radius-control",
    "radius.panel": "--radius-panel",
    "border.default": "--border-default",
    "border.icon": "--border-icon",
    "border.iconDirectional": "--border-icon-directional",
    "size.icon": "--icon-size",
    "size.hit-target": "--hit-target-size",
    "size.tree-row": "--tree-row-height",
    "size.tab-height": "--tab-height",
  };
  for (const [tokenName, variableName] of Object.entries(primitiveVariables)) {
    const token = primitives[tokenName as keyof typeof primitives];
    if (token !== undefined && "value" in token) {
      root.style.setProperty(
        variableName,
        `${token.value}${"unit" in token ? token.unit : ""}`,
      );
    }
  }

  const components = hf2Tokens.components;
  const componentVariables: Readonly<Record<string, string | number>> = {
    "--icon-button-size": components.iconButton.size,
    "--icon-button-icon-size": components.iconButton.iconSize,
    "--icon-button-stroke": components.iconButton.iconStroke,
    "--icon-button-radius": components.iconButton.radius,
    "--icon-button-focus-ring-width": `${components.iconButton.focusRingWidth.value}${components.iconButton.focusRingWidth.unit}`,
    "--icon-button-default-background":
      components.iconButton.defaultBackground.value,
    "--icon-button-default-border": components.iconButton.defaultBorder.value,
    "--icon-button-default-foreground":
      semanticTokens["color.text.secondary"].value,
    "--tab-reference-width": `${components.tab.referenceWidth.value}${components.tab.referenceWidth.unit}`,
    "--tab-component-height": components.tab.height,
    "--tab-radius": `${components.tab.radius.value}${components.tab.radius.unit}`,
    "--tab-border-width": components.tab.borderWidth,
    "--workspace-row-reference-width": `${components.workspaceRow.referenceWidth.value}${components.workspaceRow.referenceWidth.unit}`,
    "--workspace-row-height": components.workspaceRow.height,
    "--workspace-row-radius": `${components.workspaceRow.radius.value}${components.workspaceRow.radius.unit}`,
    "--workspace-row-icon-size": components.workspaceRow.iconSize,
    "--welcome-action-height": `${components.welcomeAction.height.value}${components.welcomeAction.height.unit}`,
    "--welcome-action-reference-width": `${components.welcomeAction.referenceWidth.value}${components.welcomeAction.referenceWidth.unit}`,
    "--welcome-action-radius": components.welcomeAction.radius,
    "--welcome-action-border-width": components.welcomeAction.borderWidth,
    "--welcome-action-icon-size": components.welcomeAction.iconSize,
    "--workspace-sidebar-default-width": `${components.workspaceSidebar.defaultWidth.value}${components.workspaceSidebar.defaultWidth.unit}`,
    "--workspace-sidebar-min-width": `${components.workspaceSidebar.minimumWidth.value}${components.workspaceSidebar.minimumWidth.unit}`,
    "--workspace-sidebar-max-width": `${components.workspaceSidebar.maximumWidth.value}${components.workspaceSidebar.maximumWidth.unit}`,
    "--workspace-sidebar-min-canvas-share":
      components.workspaceSidebar.pinnedMinimumCanvasShare.value,
    "--workspace-sidebar-approved-canvas-share":
      components.workspaceSidebar.approvedPinnedCanvasShare.value,
  };
  for (const [variableName, tokenValue] of Object.entries(componentVariables)) {
    if (typeof tokenValue === "string" && tokenValue.startsWith("{")) {
      const primitiveName = tokenValue.slice("{primitives.".length, -1);
      const primitive = primitives[primitiveName as keyof typeof primitives];
      if (primitive !== undefined && "value" in primitive) {
        root.style.setProperty(
          variableName,
          `${primitive.value}${"unit" in primitive ? primitive.unit : ""}`,
        );
      }
    } else {
      root.style.setProperty(variableName, String(tokenValue));
    }
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
