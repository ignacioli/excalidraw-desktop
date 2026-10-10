import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { initializeBrowserLocaleController } from "../i18n";
import { CanvasMainMenu, type EditorPreferences } from "./CanvasMainMenu";

vi.mock("@excalidraw/excalidraw", () => {
  const Item = ({
    children,
    onSelect,
    selected,
    shortcut,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
    selected?: boolean;
    shortcut?: string;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">) => (
    <button
      {...rest}
      data-selected={selected === true}
      data-shortcut={shortcut}
      onClick={onSelect}
      type="button"
    >
      {children}
    </button>
  );
  const MainMenu = ({ children }: { children: ReactNode }) => (
    <div role="menu">{children}</div>
  );
  MainMenu.Item = Item;
  MainMenu.ItemCustom = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  MainMenu.Group = ({
    children,
    title,
  }: {
    children: ReactNode;
    title?: string;
  }) => (
    <div aria-label={title} role="group">
      {children}
    </div>
  );
  MainMenu.Separator = () => <hr />;
  MainMenu.DefaultItems = {
    SearchMenu: () => <button type="button">Find on canvas</button>,
    Help: () => <button type="button">Help</button>,
    ToggleTheme: ({ theme }: { theme: string }) => (
      <div data-testid="theme" data-theme={theme} />
    ),
    ChangeCanvasBackground: () => <div data-testid="background" />,
  };
  return { MainMenu };
});

const OFF: EditorPreferences = {
  toolLock: false,
  grid: false,
  snap: false,
  zen: false,
  viewMode: false,
};

function renderMenu(
  overrides: {
    preferences?: Partial<EditorPreferences>;
    forcedReadOnly?: boolean;
  } = {},
) {
  const onTogglePreference = vi.fn();
  const onLanguageChange = vi.fn();
  render(
    <CanvasMainMenu
      appearance="system"
      forcedReadOnly={overrides.forcedReadOnly ?? false}
      onAppearanceChange={() => undefined}
      onLanguageChange={onLanguageChange}
      onTogglePreference={onTogglePreference}
      preferences={{ ...OFF, ...overrides.preferences }}
    />,
  );
  return { onTogglePreference, onLanguageChange };
}

describe("CanvasMainMenu", () => {
  it("lists the approved items in order with macOS shortcut hints", () => {
    const locale = initializeBrowserLocaleController(["en-US"]);
    act(() => locale.setPreference("en"));
    renderMenu();

    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual([
      "Find on canvas",
      "Help",
      "Tool lock",
      "Toggle grid",
      "Snap to objects",
      "Zen mode",
      "View mode",
    ]);
    expect(
      screen
        .getAllByRole("button")
        .slice(2)
        .map((button) => button.dataset.shortcut),
    ).toEqual(["Q", "Cmd+'", "Option+S", "Option+Z", "Option+R"]);
    expect(screen.getByRole("group", { name: "Preferences" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue(
      "en",
    );
  });

  it("marks selected preferences with aria-pressed", () => {
    renderMenu({ preferences: { grid: true, zen: true } });

    for (const [name, pressed] of [
      ["Tool lock", false],
      ["Toggle grid", true],
      ["Snap to objects", false],
      ["Zen mode", true],
      ["View mode", false],
    ] as const) {
      const item = screen.getByRole("button", { name });
      expect(item).toHaveAttribute("aria-pressed", String(pressed));
      expect(item.dataset.selected).toBe(String(pressed));
    }
  });

  it("disables Tool lock, Snap and View mode while forced read-only", () => {
    const { onTogglePreference } = renderMenu({
      forcedReadOnly: true,
      preferences: { viewMode: true },
    });

    for (const name of ["Tool lock", "Snap to objects", "View mode"]) {
      const item = screen.getByRole("button", { name });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("aria-disabled", "true");
    }
    expect(screen.getByRole("button", { name: "View mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const name of ["Toggle grid", "Zen mode"]) {
      const item = screen.getByRole("button", { name });
      expect(item).toBeEnabled();
      fireEvent.click(item);
    }
    expect(onTogglePreference.mock.calls).toEqual([["grid"], ["zen"]]);
  });

  it("localizes host copy and reports language selections", () => {
    const locale = initializeBrowserLocaleController(["en-US"]);
    act(() => locale.setPreference("zh-CN"));
    const { onLanguageChange } = renderMenu();

    expect(screen.getByRole("group", { name: "偏好设置" })).toBeVisible();
    const select = screen.getByRole("combobox", { name: "语言" });
    expect(
      Array.from(
        select.querySelectorAll("option"),
        (option) => option.textContent,
      ),
    ).toEqual(["跟随系统", "English", "简体中文"]);

    fireEvent.change(select, { target: { value: "system" } });
    expect(onLanguageChange).toHaveBeenCalledWith("system");
    act(() => locale.setPreference("en"));
  });
});
