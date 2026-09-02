import { describe, expect, it } from "vitest";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
  ShellPreferences,
} from "./shellPreferences";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("ShellPreferences", () => {
  it("does not write defaults until a preference actually changes", () => {
    const storage = new MemoryStorage();
    const preferences = new ShellPreferences(storage);

    expect(storage.getItem(SHELL_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(preferences.getSnapshot()).toEqual({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: false,
      expandedWorkspaceIds: [],
      currentWorkspaceId: null,
    });
  });

  it("persists pinned and independently expanded Workspaces", () => {
    const storage = new MemoryStorage();
    const preferences = new ShellPreferences(storage);
    preferences.setSidebarPinned(true);
    preferences.setCurrentWorkspaceId("workspace-b");
    preferences.setWorkspaceExpanded("workspace-a", true);
    preferences.setWorkspaceExpanded("workspace-b", true);
    preferences.setWorkspaceExpanded("workspace-a", false);

    expect(preferences.getSnapshot()).toEqual({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: true,
      expandedWorkspaceIds: ["workspace-b"],
      currentWorkspaceId: "workspace-b",
    });
    expect(new ShellPreferences(storage).getSnapshot()).toEqual(
      preferences.getSnapshot(),
    );
  });

  it.each([
    "not-json",
    JSON.stringify({
      version: SHELL_PREFERENCES_VERSION + 1,
      sidebarPinned: true,
      expandedWorkspaceIds: ["workspace-a"],
    }),
    JSON.stringify({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: "yes",
      expandedWorkspaceIds: [],
    }),
    JSON.stringify({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: false,
      expandedWorkspaceIds: ["workspace-a", 7],
    }),
  ])("falls back and repairs corrupted or future values: %s", (stored) => {
    const storage = new MemoryStorage();
    storage.values.set(SHELL_PREFERENCES_STORAGE_KEY, stored);

    const preferences = new ShellPreferences(storage);

    expect(preferences.getSnapshot()).toEqual({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: false,
      expandedWorkspaceIds: [],
      currentWorkspaceId: null,
    });
    expect(storage.getItem(SHELL_PREFERENCES_STORAGE_KEY)).toBe(
      JSON.stringify(preferences.getSnapshot()),
    );
  });

  it("keeps a valid current Workspace and falls back to none when it is missing", () => {
    const storage = new MemoryStorage();
    const preferences = new ShellPreferences(storage);
    preferences.setCurrentWorkspaceId("workspace-a");

    expect(
      preferences.resolveCurrentWorkspaceId(new Set(["workspace-a"])),
    ).toBe("workspace-a");
    expect(
      preferences.resolveCurrentWorkspaceId(new Set(["workspace-b"])),
    ).toBeNull();
    expect(
      preferences.resolveCurrentWorkspaceId(
        new Set(["workspace-b"]),
        "workspace-b",
      ),
    ).toBe("workspace-b");
  });

  it("accepts a null current Workspace in a persisted snapshot", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: false,
        expandedWorkspaceIds: [],
        currentWorkspaceId: null,
      }),
    );

    expect(new ShellPreferences(storage).getSnapshot().currentWorkspaceId).toBe(
      null,
    );
  });

  it("migrates an older snapshot without a current Workspace id", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: true,
        expandedWorkspaceIds: ["workspace-a"],
      }),
    );

    expect(new ShellPreferences(storage).getSnapshot()).toEqual({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: true,
      expandedWorkspaceIds: ["workspace-a"],
      currentWorkspaceId: null,
    });
  });
});
