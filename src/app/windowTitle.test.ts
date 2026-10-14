import { describe, expect, it } from "vitest";
import { translate, type MessageKey, type MessageParams } from "../i18n";
import { windowTitle } from "./windowTitle";

const en = (key: MessageKey, params?: MessageParams) =>
  translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) =>
  translate("zh-CN", key, params);

const notes = { id: "a", name: "notes", rootPath: "/Users/me/work/notes" };
const otherNotes = {
  workspaceId: "b",
  name: "notes",
  rootPath: "/Users/me/home/notes",
};
const open = [{ workspaceId: "a", name: "notes", rootPath: notes.rootPath }];

describe("windowTitle", () => {
  it("is the app name in a Welcome window", () => {
    expect(
      windowTitle({
        workspace: null,
        openWorkspaces: [],
        activeDrawing: null,
        t: en,
      }),
    ).toBe("Excalidraw");
  });

  it("names a drawing outside any Workspace with the app name", () => {
    expect(
      windowTitle({
        workspace: null,
        openWorkspaces: [],
        activeDrawing: "plan.excalidraw",
        t: en,
      }),
    ).toBe("plan.excalidraw — Excalidraw");
  });

  it("is the Workspace name without an active drawing", () => {
    expect(
      windowTitle({
        workspace: notes,
        openWorkspaces: open,
        activeDrawing: null,
        t: en,
      }),
    ).toBe("notes");
  });

  it("puts the active drawing before the Workspace", () => {
    expect(
      windowTitle({
        workspace: notes,
        openWorkspaces: open,
        activeDrawing: "plan.excalidraw",
        t: en,
      }),
    ).toBe("plan.excalidraw — notes");
  });

  it("adds the parent folder when another open Workspace has the same name", () => {
    const both = [...open, otherNotes];
    expect(
      windowTitle({
        workspace: notes,
        openWorkspaces: both,
        activeDrawing: null,
        t: en,
      }),
    ).toBe("notes (work)");
    expect(
      windowTitle({
        workspace: notes,
        openWorkspaces: both,
        activeDrawing: "plan.excalidraw",
        t: zh,
      }),
    ).toBe("plan.excalidraw — notes（work）");
  });

  it("does not count the window's own Workspace as a duplicate", () => {
    expect(
      windowTitle({
        workspace: notes,
        openWorkspaces: open,
        activeDrawing: null,
        t: zh,
      }),
    ).toBe("notes");
  });
});
