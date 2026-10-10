import { MainMenu } from "@excalidraw/excalidraw";
import type { ChangeEvent } from "react";
import type { ModePreference } from "../app/theme/types";
import { useI18n, type MessageKey } from "../i18n";
import type { LanguagePreference } from "../i18n/resolveLanguage";
import type { CanvasPreference, CanvasPreferences } from "./ExcalidrawAdapter";

export type EditorPreference = CanvasPreference | "viewMode";
export type EditorPreferences = CanvasPreferences & {
  readonly viewMode: boolean;
};

interface PreferenceItem {
  readonly preference: EditorPreference;
  readonly label: MessageKey;
  readonly shortcut: string;
  /** Unavailable while the document is forced read-only. */
  readonly lockedByReadOnly: boolean;
}

// Hints follow macOS modifier names, matching the SDK's own Theme hint.
const PREFERENCE_ITEMS: readonly PreferenceItem[] = [
  {
    preference: "toolLock",
    label: "menu.canvas.toolLock",
    shortcut: "Q",
    lockedByReadOnly: true,
  },
  {
    preference: "grid",
    label: "menu.canvas.toggleGrid",
    shortcut: "Cmd+'",
    lockedByReadOnly: false,
  },
  {
    preference: "snap",
    label: "menu.canvas.snapToObjects",
    shortcut: "Option+S",
    lockedByReadOnly: true,
  },
  {
    preference: "zen",
    label: "menu.canvas.zenMode",
    shortcut: "Option+Z",
    lockedByReadOnly: false,
  },
  {
    preference: "viewMode",
    label: "menu.canvas.viewMode",
    shortcut: "Option+R",
    lockedByReadOnly: true,
  },
];

const LANGUAGE_OPTIONS: readonly LanguagePreference[] = [
  "system",
  "en",
  "zh-CN",
];

function isLanguagePreference(value: string): value is LanguagePreference {
  return (LANGUAGE_OPTIONS as readonly string[]).includes(value);
}

interface CanvasMainMenuProps {
  preferences: EditorPreferences;
  forcedReadOnly: boolean;
  appearance: ModePreference;
  onTogglePreference: (preference: EditorPreference) => void;
  onAppearanceChange: (mode: ModePreference) => void;
  onLanguageChange: (preference: LanguagePreference) => void;
}

export function CanvasMainMenu({
  preferences,
  forcedReadOnly,
  appearance,
  onTogglePreference,
  onAppearanceChange,
  onLanguageChange,
}: CanvasMainMenuProps) {
  const { t, preference: language } = useI18n();

  const selectLanguage = (event: ChangeEvent<HTMLSelectElement>) => {
    if (isLanguagePreference(event.target.value)) {
      onLanguageChange(event.target.value);
    }
  };

  return (
    <MainMenu>
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.Separator />
      <MainMenu.Group title={t("menu.canvas.preferences")}>
        {PREFERENCE_ITEMS.map((item) => {
          const unavailable = forcedReadOnly && item.lockedByReadOnly;
          const selected = preferences[item.preference];
          return (
            <MainMenu.Item
              aria-disabled={unavailable ? true : undefined}
              aria-pressed={selected}
              className={
                unavailable ? "canvas-menu-item--unavailable" : undefined
              }
              disabled={unavailable}
              key={item.preference}
              onSelect={() => onTogglePreference(item.preference)}
              selected={selected}
              shortcut={item.shortcut}
            >
              {t(item.label)}
            </MainMenu.Item>
          );
        })}
        <MainMenu.ItemCustom className="canvas-language-item">
          <span className="canvas-language-select">
            <select
              aria-label={t("menu.canvas.language")}
              onChange={selectLanguage}
              value={language}
            >
              <option value="system">{t("menu.canvas.languageSystem")}</option>
              {/* Language self-names stay untranslated in both UI languages. */}
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
            <svg
              aria-hidden="true"
              className="canvas-language-select__chevron"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              viewBox="0 0 14 14"
            >
              <path d="M4.5 5.5 7 3l2.5 2.5M4.5 8.5 7 11l2.5-2.5" />
            </svg>
          </span>
        </MainMenu.ItemCustom>
      </MainMenu.Group>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme
        allowSystemTheme
        onSelect={onAppearanceChange}
        theme={appearance}
      />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
}
