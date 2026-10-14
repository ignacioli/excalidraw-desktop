import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BINARY,
  checkAvailability,
  exitCodeFor,
  frontWindow,
  parseArgs,
  parseWindowList,
} from "./native-window-check.mjs";

describe("parseArgs", () => {
  it("runs the executable inside an .app bundle", () => {
    assert.deepEqual(parseArgs(["--app", "/tmp/Excalidraw.app"]), {
      app: "/tmp/Excalidraw.app",
      binary: "/tmp/Excalidraw.app/Contents/MacOS/excalidraw-desktop",
    });
  });

  it("rejects an --app path that is not a bundle", () => {
    assert.match(parseArgs(["--app", "/tmp/excalidraw"]).error, /\.app/u);
  });

  it("falls back to the debug binary", () => {
    assert.deepEqual(parseArgs([]), { app: null, binary: DEFAULT_BINARY });
    assert.deepEqual(parseArgs(["--binary", "/tmp/bin"]), {
      app: null,
      binary: "/tmp/bin",
    });
  });
});

describe("window list", () => {
  const raw = [
    "alpha\tfalse\t100\t80\t1280\t760",
    "beta\ttrue\t130\t110\t1280\t760",
  ].join("\n");

  it("parses names, minimized state and bounds front to back", () => {
    assert.deepEqual(parseWindowList(raw), [
      {
        name: "alpha",
        minimized: false,
        bounds: { x: 100, y: 80, width: 1280, height: 760 },
      },
      {
        name: "beta",
        minimized: true,
        bounds: { x: 130, y: 110, width: 1280, height: 760 },
      },
    ]);
    assert.deepEqual(parseWindowList(""), []);
  });

  it("treats the first window that is not minimized as the front window", () => {
    const windows = parseWindowList(
      ["beta\ttrue\t0\t0\t1\t1", "alpha\tfalse\t0\t0\t1\t1"].join("\n"),
    );
    assert.equal(frontWindow(windows)?.name, "alpha");
    assert.equal(frontWindow([]), null);
  });
});

describe("results", () => {
  it("blocks LaunchServices checks without an .app", () => {
    const dock = { requiresLaunchServices: true };
    assert.equal(checkAvailability(dock, { hasApp: false }), "BLOCKED");
    assert.equal(checkAvailability(dock, { hasApp: true }), "RUN");
    assert.equal(checkAvailability({}, { hasApp: false }), "RUN");
  });

  it("exits 1 on any failure, 2 when blocked, else 0", () => {
    assert.equal(exitCodeFor(["PASS", "BLOCKED", "FAIL"]), 1);
    assert.equal(exitCodeFor(["PASS", "BLOCKED"]), 2);
    assert.equal(exitCodeFor(["PASS", "PASS"]), 0);
  });
});
