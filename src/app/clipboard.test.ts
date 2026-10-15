import { describe, expect, it, vi } from "vitest";
import {
  copyPath,
  workspaceRelativePath,
  type ClipboardPort,
} from "./clipboard";

vi.mock("@excalidraw/excalidraw", () => ({}));

function fakeClipboard(fail = false) {
  const written: string[] = [];
  const clipboard: ClipboardPort = {
    writeText: vi.fn(async (text: string) => {
      if (fail) throw new Error("clipboard unavailable");
      written.push(text);
    }),
  };
  return { clipboard, written };
}

describe("copyPath", () => {
  it("writes the whole path, spaces and Chinese included", async () => {
    const { clipboard, written } = fakeClipboard();
    const path = "/Users/me/My Drawings/计划/计划 草图.excalidraw";
    await expect(
      copyPath(clipboard, { kind: "path", resolve: () => path }),
    ).resolves.toEqual({ status: "copied", kind: "path", text: path });
    expect(written).toEqual([path]);
  });

  it("reads the path only when the copy runs", async () => {
    const { clipboard, written } = fakeClipboard();
    let current = "/a/old.excalidraw";
    const request = { kind: "path" as const, resolve: () => current };
    current = "/a/new.excalidraw";
    await copyPath(clipboard, request);
    expect(written).toEqual(["/a/new.excalidraw"]);
  });

  it("does not write when the item no longer exists", async () => {
    const { clipboard } = fakeClipboard();
    await expect(
      copyPath(clipboard, { kind: "relativePath", resolve: () => null }),
    ).resolves.toEqual({ status: "missing" });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("reports a failed write", async () => {
    const { clipboard } = fakeClipboard(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      copyPath(clipboard, { kind: "path", resolve: () => "/a/b.excalidraw" }),
    ).resolves.toEqual({ status: "failed" });
  });
});

describe("workspaceRelativePath", () => {
  it("is the `/`-separated path below the root, without a leading slash", () => {
    expect(
      workspaceRelativePath(
        "/Users/me/Drawings/",
        "/Users/me/Drawings/a/b.excalidraw",
      ),
    ).toBe("a/b.excalidraw");
  });

  it("is null outside the root and for the root itself", () => {
    expect(
      workspaceRelativePath("/Users/me/Drawings", "/tmp/a.excalidraw"),
    ).toBeNull();
    expect(
      workspaceRelativePath(
        "/Users/me/Drawings",
        "/Users/me/Drawings-old/a.excalidraw",
      ),
    ).toBeNull();
    expect(
      workspaceRelativePath("/Users/me/Drawings", "/Users/me/Drawings"),
    ).toBeNull();
  });
});
