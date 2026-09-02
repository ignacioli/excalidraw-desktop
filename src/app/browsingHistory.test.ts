import { describe, expect, it } from "vitest";
import { BrowsingHistory, type BrowsingLocation } from "./browsingHistory";

const root: BrowsingLocation = {
  workspaceId: "workspace-1",
  directoryRelativePath: "",
};
const notes: BrowsingLocation = {
  workspaceId: "workspace-1",
  directoryRelativePath: "notes",
};

describe("BrowsingHistory", () => {
  it("pushes locations and pops the previous location in reverse order", () => {
    const history = new BrowsingHistory();
    history.push(root);
    history.push(notes);

    expect(history.canGoBack()).toBe(true);
    expect(history.pop()).toEqual(notes);
    expect(history.pop()).toEqual(root);
    expect(history.canGoBack()).toBe(false);
    expect(history.pop()).toBeNull();
  });

  it("skips invalid locations and disables Back when none remain", () => {
    const history = new BrowsingHistory([root, notes]);
    const valid = (location: BrowsingLocation) =>
      location.directoryRelativePath === "";

    expect(history.canGoBack(valid)).toBe(true);
    expect(history.pop(valid)).toEqual(root);
    expect(history.canGoBack(valid)).toBe(false);
    expect(history.getSnapshot()).toEqual([]);
  });

  it("does not expose mutable internal locations", () => {
    const history = new BrowsingHistory([root]);
    const snapshot = history.getSnapshot();
    snapshot[0].workspaceId = "changed";

    expect(history.getSnapshot()).toEqual([root]);
  });
});
