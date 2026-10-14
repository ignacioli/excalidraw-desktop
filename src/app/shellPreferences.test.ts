import { describe, expect, it, vi } from "vitest";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  ShellPreferences,
  importLegacyShellPreferences,
  legacyShellStateFor,
  readLegacyShellPreferences,
} from "./shellPreferences";

function storageWith(value: string | null) {
  return {
    getItem: (key: string) =>
      key === SHELL_PREFERENCES_STORAGE_KEY ? value : null,
  };
}

describe("ShellPreferences", () => {
  it("stores nothing until the window has a Workspace", () => {
    const save = vi.fn();
    const preferences = new ShellPreferences(save);

    preferences.setSidebarPinned(true);
    expect(save).not.toHaveBeenCalled();

    preferences.loadWorkspace(null);
    preferences.setSidebarWidth(400);
    expect(save).toHaveBeenLastCalledWith({
      sidebarPinned: false,
      sidebarWidth: 400,
      expanded: [""],
    });

    preferences.closeWorkspace();
    preferences.setSidebarPinned(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("shows a Workspace's own state without storing it again", () => {
    const save = vi.fn();
    const preferences = new ShellPreferences(save);
    const listener = vi.fn();
    preferences.subscribe(listener);

    preferences.loadWorkspace({
      sidebarPinned: true,
      sidebarWidth: 320,
      expanded: ["drafts", "drafts"],
    });

    expect(preferences.getSnapshot()).toEqual({
      sidebarPinned: true,
      sidebarWidth: 320,
      expanded: ["drafts"],
    });
    expect(preferences.isWorkspaceExpanded()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("opens a Workspace with nothing saved expanded with the default width", () => {
    const preferences = new ShellPreferences();
    preferences.loadWorkspace(null);

    expect(preferences.getSnapshot()).toEqual({
      sidebarPinned: false,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      expanded: [""],
    });
    expect(preferences.isWorkspaceExpanded()).toBe(true);
  });

  it("keeps folder expansion when the Workspace row collapses and expands", () => {
    const save = vi.fn();
    const preferences = new ShellPreferences(save);
    preferences.loadWorkspace({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: ["", "drafts"],
    });

    preferences.setWorkspaceExpanded(false);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ expanded: ["drafts"] }),
    );
    preferences.setWorkspaceExpanded(true);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ expanded: ["", "drafts"] }),
    );
  });

  it("clamps the sidebar width to the approved bounds", () => {
    const preferences = new ShellPreferences();
    preferences.setSidebarWidth(SIDEBAR_WIDTH_MAX + 200);
    expect(preferences.getSnapshot().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    preferences.loadWorkspace({
      sidebarPinned: false,
      sidebarWidth: 10,
      expanded: [],
    });
    expect(preferences.getSnapshot().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("shows state in a window without a Workspace and stores nothing", () => {
    const save = vi.fn();
    const preferences = new ShellPreferences(save);
    preferences.loadWorkspace(null);

    preferences.showWithoutWorkspace({
      sidebarPinned: true,
      sidebarWidth: 300,
      expanded: [],
    });
    preferences.setSidebarWidth(310);

    expect(preferences.getSnapshot().sidebarPinned).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("legacy shell preferences", () => {
  const legacy = JSON.stringify({
    version: 1,
    sidebarPinned: true,
    sidebarWidth: 1000,
    expandedWorkspaceIds: ["a", "a"],
    currentWorkspaceId: "a",
  });

  it("reads the pre-multi-window snapshot", () => {
    expect(readLegacyShellPreferences(storageWith(legacy))).toEqual({
      sidebarPinned: true,
      sidebarWidth: SIDEBAR_WIDTH_MAX,
      expandedWorkspaceIds: ["a"],
      currentWorkspaceId: "a",
    });
  });

  it("reads an older snapshot without a width or Current Workspace", () => {
    expect(
      readLegacyShellPreferences(
        storageWith(
          JSON.stringify({
            version: 1,
            sidebarPinned: false,
            expandedWorkspaceIds: [],
          }),
        ),
      ),
    ).toEqual({
      sidebarPinned: false,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      expandedWorkspaceIds: [],
      currentWorkspaceId: null,
    });
  });

  it.each([null, "not json", JSON.stringify({ version: 2 })])(
    "ignores a missing or malformed snapshot (%s)",
    (stored) => {
      expect(readLegacyShellPreferences(storageWith(stored))).toBeNull();
    },
  );

  it("ignores storage that cannot be read", () => {
    expect(
      readLegacyShellPreferences({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  it("keeps the snapshot in effect until its import is recorded", async () => {
    const answer = (result: Promise<unknown>) =>
      ({
        invoke: vi.fn(() => result),
      }) as unknown as Parameters<typeof importLegacyShellPreferences>[0];
    const storage = storageWith(legacy);

    const first = answer(Promise.resolve({ migrated: true }));
    expect(await importLegacyShellPreferences(first, storage)).toMatchObject({
      currentWorkspaceId: "a",
    });
    expect(first.invoke).toHaveBeenCalledWith("shell_preferences_migrate", {
      sidebarPinned: true,
      sidebarWidth: SIDEBAR_WIDTH_MAX,
    });
    expect(
      await importLegacyShellPreferences(
        answer(Promise.reject(new Error("offline"))),
        storage,
      ),
    ).not.toBeNull();
    expect(
      await importLegacyShellPreferences(
        answer(Promise.resolve({ migrated: false })),
        storage,
      ),
    ).toBeNull();

    const none = answer(Promise.resolve({ migrated: true }));
    expect(
      await importLegacyShellPreferences(none, storageWith(null)),
    ).toBeNull();
    expect(none.invoke).not.toHaveBeenCalled();
  });

  it("turns the snapshot into one Workspace's state", () => {
    const parsed = readLegacyShellPreferences(storageWith(legacy));
    if (parsed === null) throw new Error("expected legacy preferences");
    expect(legacyShellStateFor(parsed, "a")).toEqual({
      sidebarPinned: true,
      sidebarWidth: SIDEBAR_WIDTH_MAX,
      expanded: [""],
    });
    expect(legacyShellStateFor(parsed, "b").expanded).toEqual([]);
    expect(legacyShellStateFor(parsed, null).expanded).toEqual([]);
  });
});
