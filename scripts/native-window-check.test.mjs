import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  DEFAULT_BINARY,
  NESTED_DIALOG_BUTTONS,
  QUIT_DRAWING_SCENE,
  checkAvailability,
  drawingTitle,
  exitCodeFor,
  frontWindow,
  hasButtons,
  listedWindows,
  listsEveryWindow,
  parseArgs,
  parseButtonNames,
  parseWindowList,
  quitWasCoordinated,
  rectangleMoved,
} from "./native-window-check.mjs";

describe("parseArgs", () => {
  it("runs the executable inside an .app bundle", () => {
    assert.deepEqual(parseArgs(["--app", "/tmp/Excalidraw.app"]), {
      app: "/tmp/Excalidraw.app",
      binary: "/tmp/Excalidraw.app/Contents/MacOS/excalidraw-desktop",
    });
  });

  it("makes a relative --app path absolute for open -a", () => {
    const app = path.resolve(
      "src-tauri/target/debug/bundle/macos/Excalidraw.app",
    );
    assert.deepEqual(
      parseArgs([
        "--app",
        "src-tauri/target/debug/bundle/macos/Excalidraw.app",
      ]),
      { app, binary: path.join(app, "Contents/MacOS/excalidraw-desktop") },
    );
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

describe("nested-Workspace dialog", () => {
  it("reads web button names from either the title or the description", () => {
    const names = parseButtonNames(
      "Close it and open here\tmissing value\n\tCancel\nSwitch to that window\t\n",
    );
    assert.deepEqual(names, [
      "Close it and open here",
      "Cancel",
      "Switch to that window",
    ]);
    assert.equal(hasButtons(names, NESTED_DIALOG_BUTTONS), true);
    assert.equal(hasButtons(names.slice(1), NESTED_DIALOG_BUTTONS), false);
    assert.deepEqual(parseButtonNames(""), []);
  });
});

describe("drawing titles", () => {
  it("names the active drawing and the Workspace", () => {
    assert.equal(drawingTitle("in-a", "alpha"), "in-a — alpha");
  });
});

describe("quitWasCoordinated", () => {
  it("needs the request to every window before the exit", () => {
    assert.equal(
      quitWasCoordinated(
        "app-quit-requested q1 to window-1,window-2\napp-quit-exit\n",
      ),
      true,
    );
    assert.equal(quitWasCoordinated("app-quit-exit\n"), false);
    assert.equal(
      quitWasCoordinated("app-quit-requested q1 to window-1\n"),
      false,
    );
  });

  it("rejects a quit that was cancelled on the way", () => {
    assert.equal(
      quitWasCoordinated(
        "app-quit-requested q1 to window-1\napp-quit-cancelled q1 by window-1\napp-quit-requested q2 to window-1\napp-quit-exit\n",
      ),
      false,
    );
  });
});

describe("listedWindows", () => {
  it("keeps the titles that the Window menu lists", () => {
    assert.deepEqual(
      listedWindows(["Minimize", "Zoom", "alpha", "beta"], ["alpha", "gamma"]),
      ["alpha"],
    );
  });
});

describe("listsEveryWindow", () => {
  const items = ["Minimize", "Zoom", "Close Window", "alpha", "beta"];

  it("passes when every window title is a Window menu item", () => {
    assert.equal(listsEveryWindow(items, ["alpha", "beta"]), true);
  });

  it("fails when a window is missing from the Window menu", () => {
    assert.equal(listsEveryWindow(items, ["alpha", "gamma"]), false);
    assert.equal(
      listsEveryWindow(["Minimize", "Zoom", "Close Window"], ["alpha"]),
      false,
    );
  });

  it("fails when there is no window to list", () => {
    assert.equal(listsEveryWindow(items, []), false);
  });
});

describe("rectangleMoved", () => {
  it("starts unmoved and moves once x grows", () => {
    const scene = JSON.parse(QUIT_DRAWING_SCENE);
    assert.equal(rectangleMoved(scene), false);
    scene.elements[0].x = 101;
    assert.equal(rectangleMoved(scene), true);
    assert.equal(rectangleMoved({ elements: [] }), false);
  });
});
