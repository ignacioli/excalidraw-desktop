import { expect, type Locator, type Page } from "@playwright/test";
import { emitBrowserTauriEvent } from "./browserTauriHarness";

export type CanvasPreference =
  "toolLock" | "grid" | "snap" | "zen" | "viewMode";

export interface NativeMenuSyncState {
  language: string;
  appearance: string;
  hasDocument: boolean;
  forcedReadOnly: boolean;
  toolLock: boolean;
  grid: boolean;
  snap: boolean;
  zen: boolean;
  viewMode: boolean;
}

export const PREFERENCE_ENTRIES: Readonly<
  Record<
    CanvasPreference,
    { label: string; shortcut: string; nativeCommand: string }
  >
> = {
  toolLock: {
    label: "Tool lock",
    shortcut: "q",
    nativeCommand: "toggleToolLock",
  },
  grid: {
    label: "Toggle grid",
    shortcut: "Meta+Quote",
    nativeCommand: "toggleGrid",
  },
  snap: {
    label: "Snap to objects",
    shortcut: "Alt+KeyS",
    nativeCommand: "toggleSnap",
  },
  zen: { label: "Zen mode", shortcut: "Alt+KeyZ", nativeCommand: "toggleZen" },
  viewMode: {
    label: "View mode",
    shortcut: "Alt+KeyR",
    nativeCommand: "toggleViewMode",
  },
};

/** The visible tab's editor; hidden tabs keep their own editors mounted. */
export function activeEditor(page: Page): Locator {
  return page.locator(".canvas-document:not([hidden]) .excalidraw-editor");
}

export async function openWelcomeDrawing(page: Page): Promise<void> {
  await page
    .getByTestId("welcome-screen")
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
  await expect(activeEditor(page)).toBeVisible();
}

/** Menu items carry their shortcut hint in the accessible name. */
export function canvasMenuItem(page: Page, label: string): Locator {
  return activeEditor(page).getByRole("button", {
    name: new RegExp(`^${escapeRegExp(label)}(\\s|$)`),
  });
}

export async function openCanvasMenu(
  page: Page,
  triggerName = "Menu",
): Promise<void> {
  const trigger = activeEditor(page).getByRole("button", {
    name: triggerName,
    exact: true,
  });
  if (await canvasMenuOpen(page)) return;
  await trigger.click();
  await expect(activeEditor(page).getByRole("combobox")).toBeVisible();
}

export async function closeCanvasMenu(page: Page): Promise<void> {
  if (!(await canvasMenuOpen(page))) return;
  await activeEditor(page)
    .getByRole("button", { name: /^(Menu|菜单)$/ })
    .click();
  await expect(activeEditor(page).getByRole("combobox")).toHaveCount(0);
}

async function canvasMenuOpen(page: Page): Promise<boolean> {
  return (await activeEditor(page).getByRole("combobox").count()) > 0;
}

/**
 * Top-level role/name pairs of the open canvas menu, read from the
 * accessibility tree: everything after the trigger up to the background item.
 */
export async function canvasMenuEntries(
  page: Page,
  triggerName: string,
  lastEntry: string,
): Promise<string[]> {
  const snapshot = await activeEditor(page).ariaSnapshot();
  const entries: string[] = [];
  let inMenu = false;
  for (const line of snapshot.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const match = /^- (\w+)(?: "([^"]*)")?(?: \[[^\]]*\])*(?::\s*(.*))?$/u.exec(
      line,
    );
    if (match === null) continue;
    const [, role, name, text] = match;
    const entry = `${role}:${name ?? text ?? ""}`;
    if (!inMenu) {
      inMenu = entry === `button:${triggerName}`;
      continue;
    }
    entries.push(entry);
    if (entry === lastEntry) return entries;
  }
  throw new Error(`Canvas menu end "${lastEntry}" not found:\n${snapshot}`);
}

export async function focusCanvas(page: Page): Promise<void> {
  // The host-owned editor container; the canvas fills it.
  const box = await activeEditor(page).boundingBox();
  if (box === null) throw new Error("The canvas was not measurable.");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function nativeMenuState(
  page: Page,
): Promise<NativeMenuSyncState | undefined> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __browserTauriNativeMenuSync?: { state?: NativeMenuSyncState };
        }
      ).__browserTauriNativeMenuSync?.state,
  );
}

export async function emitNativeCommand(
  page: Page,
  command: string,
): Promise<void> {
  await emitBrowserTauriEvent(page, "native-menu-command", { command });
}

/** Asserts the canvas menu and the native menu agree on one preference. */
export async function expectPreference(
  page: Page,
  preference: CanvasPreference,
  enabled: boolean,
): Promise<void> {
  await expect
    .poll(async () => (await nativeMenuState(page))?.[preference])
    .toBe(enabled);
  await openCanvasMenu(page);
  await expect(
    canvasMenuItem(page, PREFERENCE_ENTRIES[preference].label),
  ).toHaveAttribute("aria-pressed", String(enabled));
  await closeCanvasMenu(page);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
