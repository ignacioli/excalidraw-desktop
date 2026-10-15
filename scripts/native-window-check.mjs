#!/usr/bin/env node
// Native window check for a built app (macOS): window count, titles, front
// window, bounds, and minimized state through Accessibility / System Events;
// nested folders and where opened drawings go; closing every window, Reopen,
// and Cmd+Q with an unsaved keyboard edit; the first window's size, a
// Workspace window's bounds after closing and reopening it, and after a
// normal quit and relaunch. Drawings are handed over with `open -a`
// when --app is given, else by a second launch of the binary. Whether the
// Window menu lists the windows is printed as an observation.
// Usage: pnpm native:window:check -- [--app PATH.app | --binary PATH].
// Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED. Brings the app to the foreground; do
// not touch the keyboard or mouse while it runs. Checks that need the app to
// be known to LaunchServices (Finder open, Dock reopen) report BLOCKED
// without --app.
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/messages/en.ts";

export const DEFAULT_BINARY = "src-tauri/target/debug/excalidraw-desktop";
export const APP_EXECUTABLE = "Contents/MacOS/excalidraw-desktop";
export const WELCOME_TITLE = "Excalidraw";
export const REPEATED_OPENS = 20;

/** `--app` wins over `--binary`; an `--app` path must name a `.app`. */
export function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const app = value("--app");
  if (app !== undefined) {
    if (!app.endsWith(".app")) {
      return { error: `--app must name a .app bundle: ${app}` };
    }
    return { app, binary: path.join(app, APP_EXECUTABLE) };
  }
  return { app: null, binary: value("--binary") ?? DEFAULT_BINARY };
}

/**
 * Parse the window rows printed by WINDOW_DUMP: name, minimized, x, y,
 * width, height. System Events lists windows front to back.
 */
export function parseWindowList(raw) {
  if (raw.trim() === "") return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const [name, minimized, x, y, width, height] = line.split("\t");
      return {
        name,
        minimized: minimized === "true",
        bounds: {
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
        },
      };
    });
}

/** The front window: the first one that is not minimized. */
export function frontWindow(windows) {
  return windows.find((window) => !window.minimized) ?? null;
}

/** The nested-Workspace dialog's buttons, as Accessibility names them. */
export const NESTED_DIALOG_BUTTONS = [
  en["workspace.nested.closeAndOpen"],
  en["workspace.nested.cancel"],
  en["workspace.nested.switch"],
];

/**
 * Parse the button rows printed by BUTTON_DUMP: title and description. A
 * web button's name is in either one.
 */
export function parseButtonNames(raw) {
  if (raw.trim() === "") return [];
  return raw
    .trim()
    .split("\n")
    .flatMap((line) => line.split("\t"))
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "missing value");
}

/** Every expected button name is present. */
export function hasButtons(names, expected) {
  return expected.every((name) => names.includes(name));
}

/** `{drawing} — {workspace}`, as the window title shows an active drawing. */
export function drawingTitle(drawing, workspace) {
  return en["shell.windowTitle.drawing"]
    .replace("{drawing}", drawing)
    .replace("{context}", workspace);
}

/** A check that needs LaunchServices cannot run against a bare binary. */
export function checkAvailability(check, { hasApp }) {
  return check.requiresLaunchServices && !hasApp ? "BLOCKED" : "RUN";
}

/**
 * The coordinated quit, as the app logs it: the request to every window,
 * then the exit, with no cancellation between them.
 */
export function quitWasCoordinated(log) {
  const requested = log.indexOf("app-quit-requested");
  const exited = log.indexOf("app-quit-exit");
  return (
    requested >= 0 && exited > requested && !log.includes("app-quit-cancelled")
  );
}

/** The window titles that the Window menu lists. */
export function listedWindows(menuItems, titles) {
  return titles.filter((title) => menuItems.includes(title));
}

/** One rectangle at x = 100; the Cmd+Q check moves it one step right. */
export const QUIT_DRAWING_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "native-window-check",
  elements: [
    {
      id: "native-window-check-rect",
      type: "rectangle",
      x: 100,
      y: 100,
      width: 120,
      height: 80,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a0",
      roundness: null,
      boundElements: null,
      updated: 1,
      seed: 7,
      version: 1,
      versionNonce: 11,
      isDeleted: false,
      locked: false,
      link: null,
    },
  ],
  appState: {},
  files: {},
});

/** Whether the rectangle on disk moved right of where it started. */
export function rectangleMoved(scene) {
  const rectangle = (scene.elements ?? []).find(
    (element) => element.id === "native-window-check-rect",
  );
  return rectangle !== undefined && rectangle.x > 100;
}

/** Smallest window content size, in points. */
export const MIN_SIZE = { width: 960, height: 640 };
/** Bounds read back through Accessibility may differ by a rounding step. */
export const BOUNDS_TOLERANCE = 1;
/** Height of the system title bar that the outer frame adds, at most. */
export const MAX_TITLE_BAR = 60;

/**
 * Content size of a window without remembered placement on `workArea`: 90%
 * of the work area, at most 1680×1050 and at least the minimum size.
 */
export function expectedInitialSize(workArea) {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  return {
    width: clamp(Math.floor(workArea.width * 0.9), MIN_SIZE.width, 1680),
    height: clamp(Math.floor(workArea.height * 0.9), MIN_SIZE.height, 1050),
  };
}

/**
 * Whether the first window's outer frame (title bar included) follows the
 * initial size rule, lies inside the work area, and, on a work area of at
 * least 1440×900, has content of at least 1280×760.
 */
export function firstWindowFits(bounds, workArea) {
  const expected = expectedInitialSize(workArea);
  const titleBar = bounds.height - expected.height;
  const inside =
    bounds.x >= workArea.x - BOUNDS_TOLERANCE &&
    bounds.y >= workArea.y - BOUNDS_TOLERANCE &&
    bounds.x + bounds.width <= workArea.x + workArea.width + BOUNDS_TOLERANCE &&
    bounds.y + bounds.height <= workArea.y + workArea.height + BOUNDS_TOLERANCE;
  const sized =
    Math.abs(bounds.width - expected.width) <= BOUNDS_TOLERANCE &&
    titleBar >= 0 &&
    titleBar <= MAX_TITLE_BAR;
  const large = workArea.width >= 1440 && workArea.height >= 900;
  const target = !large || (expected.width >= 1280 && expected.height >= 760);
  return { ok: inside && sized && target, expected, inside, sized, target };
}

/** Two window frames match within the rounding tolerance. */
export function sameBounds(left, right) {
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs(left[key] - right[key]) <= BOUNDS_TOLERANCE,
  );
}

/**
 * Bounds to move a window to inside `workArea`: offset from its top-left
 * corner and smaller than the initial size, so they differ from both the
 * centered and the staggered default.
 */
export function adjustedBounds(workArea) {
  return {
    x: Math.round(workArea.x + 40),
    y: Math.round(workArea.y + 30),
    width: Math.max(MIN_SIZE.width + 80, Math.round(workArea.width * 0.7)),
    height: Math.max(MIN_SIZE.height + 60, Math.round(workArea.height * 0.75)),
  };
}

/** `x\ty\twidth\theight` as printed by PRIMARY_WORK_AREA. */
export function parseWorkArea(raw) {
  const [x, y, width, height] = raw.trim().split("\t").map(Number);
  return { x, y, width, height };
}

/** FAIL beats BLOCKED beats PASS. */
export function exitCodeFor(statuses) {
  if (statuses.includes("FAIL")) return 1;
  if (statuses.includes("BLOCKED")) return 2;
  return 0;
}

const WINDOW_DUMP = `on run argv
  set pidValue to (item 1 of argv) as integer
  set out to {}
  tell application "System Events" to tell (first process whose unix id is pidValue)
    repeat with w in windows
      set m to false
      try
        set m to value of attribute "AXMinimized" of w
      end try
      set p to position of w
      set s to size of w
      set end of out to (name of w) & tab & m & tab & (item 1 of p) & tab & (item 2 of p) & tab & (item 1 of s) & tab & (item 2 of s)
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run`;

// The primary display's work area in top-left screen coordinates, the ones
// System Events reports window positions in.
const PRIMARY_WORK_AREA = `ObjC.import("AppKit");
const screen = $.NSScreen.screens.objectAtIndex(0);
const full = screen.frame;
const visible = screen.visibleFrame;
const top = full.size.height - (visible.origin.y + visible.size.height);
[visible.origin.x, top, visible.size.width, visible.size.height].join("\\t");`;

const ROLE_DUMP = `on run argv
  set windowName to item 2 of argv
  set out to {}
  tell application "System Events" to tell (first process whose unix id is ((item 1 of argv) as integer))
    set found to entire contents of (first window whose name is windowName)
    set end of out to "count=" & (count of found)
    repeat with e in found
      try
        set end of out to (role of e as text) & ":" & (title of e as text) & ":" & (description of e as text)
      end try
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run`;

const BUTTON_DUMP = `on run argv
  set windowName to item 2 of argv
  set out to {}
  tell application "System Events" to tell (first process whose unix id is ((item 1 of argv) as integer))
    set found to entire contents of (first window whose name is windowName)
    repeat with e in found
      try
        if (role of e as text) is "AXButton" then set end of out to (title of e as text) & tab & (description of e as text)
      end try
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run`;

const STATIC_TEXT_DUMP = `on run argv
  set out to {}
  tell application "System Events" to tell (first process whose unix id is ((item 1 of argv) as integer))
    set found to entire contents of window 1
    repeat with e in found
      try
        if (role of e as text) is "AXStaticText" then set end of out to (value of e as text)
      end try
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const statuses = [];
  const children = new Set();
  const cleanups = [];
  const finish = (code) => {
    // Never leave a launched app behind: it would capture the next launch.
    for (const child of children) child.kill("SIGKILL");
    for (const cleanup of cleanups) cleanup();
    process.exit(code);
  };
  const report = (status, name, detail = "") => {
    statuses.push(status);
    console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const block = (reason) => {
    report("BLOCKED", reason);
    finish(2);
  };
  const check = (name, ok, detail) =>
    report(ok ? "PASS" : "FAIL", name, detail);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const osa = (script, ...args) =>
    execFileSync("osascript", ["-e", script, ...args.map(String)], {
      encoding: "utf8",
    }).trim();

  if (options.error !== undefined) block(options.error);
  try {
    execFileSync("pgrep", ["-x", "excalidraw-desktop"]);
    block("an Excalidraw instance is already running");
  } catch (error) {
    if (error.status !== 1) throw error;
  }

  const root = mkdtempSync(path.join(tmpdir(), "native-window-check-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // A sits in its own parent folder, so opening that parent conflicts
  // with A only.
  const folders = {
    outer: path.join(root, "outer"),
    a: path.join(root, "outer", "alpha"),
    sub: path.join(root, "outer", "alpha", "sub"),
    b: path.join(root, "beta"),
    loose: path.join(root, "loose"),
  };
  for (const folder of Object.values(folders)) {
    mkdirSync(folder, { recursive: true });
  }
  const scene = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "native-window-check",
    elements: [],
    appState: {},
    files: {},
  });
  const drawings = {
    inA: path.join(folders.a, "in-a.excalidraw"),
    alsoInA: path.join(folders.a, "also-in-a.excalidraw"),
    outside: path.join(folders.loose, "outside.excalidraw"),
  };
  for (const drawing of Object.values(drawings)) {
    writeFileSync(drawing, scene);
  }
  drawings.quit = path.join(folders.loose, "quit.excalidraw");
  writeFileSync(drawings.quit, QUIT_DRAWING_SCENE);

  const env = { ...process.env, HOME: path.join(root, "home") };
  const child = spawn(options.binary, ["-AppleLanguages", "(en-US)"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let appLog = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    appLog = (appLog + chunk).slice(-65_536);
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.on("error", (error) =>
    block(`cannot launch ${options.binary}: ${error.message}`),
  );
  const pid = child.pid;
  const proc = `first process whose unix id is ${pid}`;

  const windows = () => parseWindowList(osa(WINDOW_DUMP, pid));
  const waitFor = async (what, ready, timeoutMs = 30_000) => {
    let last = [];
    for (
      const deadline = Date.now() + timeoutMs;
      Date.now() < deadline;
      await sleep(250)
    ) {
      try {
        last = windows();
        if (ready(last)) return last;
      } catch {
        // The process or its windows are not available yet.
      }
    }
    return { timedOut: what, last };
  };
  const timedOut = (value) => !Array.isArray(value);
  const describe = (list) =>
    (Array.isArray(list) ? list : list.last)
      .map((window) => `${window.name}${window.minimized ? " (min)" : ""}`)
      .join(", ");
  const menuItem = (key) => en[key];
  const clickFileItem = (key) =>
    osa(`tell application "System Events" to tell (${proc})
  set frontmost to true
  click menu item "${menuItem(key)}" of menu 1 of menu bar item "${menuItem("menu.native.file")}" of menu bar 1
end tell`);
  const raise = (name) =>
    osa(`tell application "System Events" to tell (${proc})
  set frontmost to true
  perform action "AXRaise" of (first window whose name is "${name}")
end tell`);
  const minimize = (name) =>
    osa(`tell application "System Events" to tell (${proc})
  set value of attribute "AXMinimized" of (first window whose name is "${name}") to true
end tell`);
  const setBounds = (name, bounds) =>
    osa(`tell application "System Events" to tell (${proc})
  set w to (first window whose name is "${name}")
  set position of w to {${bounds.x}, ${bounds.y}}
  set size of w to {${bounds.width}, ${bounds.height}}
end tell`);
  const boundsOf = (name) =>
    windows().find((window) => window.name === name)?.bounds ?? null;
  const closeWindow = (name) =>
    osa(`tell application "System Events" to tell (${proc})
  click (first button of (first window whose name is "${name}") whose subrole is "AXCloseButton")
end tell`);
  // Placement is stored 500 ms after the last move; wait past that.
  const PLACEMENT_SETTLE_MS = 1_500;
  const sheetCount = (of) => {
    try {
      return Number(
        osa(
          `tell application "System Events" to tell (${proc}) to count sheets of ${of}`,
        ),
      );
    } catch {
      return 0;
    }
  };
  const waitUntil = async (what, ready, timeoutMs = 10_000) => {
    for (
      const deadline = Date.now() + timeoutMs;
      Date.now() < deadline;
      await sleep(150)
    ) {
      if (ready()) return;
    }
    block(`timed out waiting for ${what}`);
  };
  // Open Workspace… shows the folder panel as a sheet of the front window;
  // Go to Folder opens a nested sheet whose text field takes the path
  // through Accessibility, so no path is typed key by key.
  const openWorkspace = async (folder) => {
    clickFileItem("menu.native.file.openWorkspace");
    await waitUntil("the folder panel", () => sheetCount("window 1") > 0);
    osa(
      `tell application "System Events" to tell (${proc}) to keystroke "g" using {command down, shift down}`,
    );
    await waitUntil(
      "Go to Folder",
      () => sheetCount("sheet 1 of window 1") > 0,
    );
    osa(`tell application "System Events" to tell (${proc})
  set value of text field 1 of sheet 1 of sheet 1 of window 1 to "${folder.replaceAll('"', '\\"')}"
  key code 36
end tell`);
    await waitUntil(
      "Go to Folder to close",
      () => sheetCount("sheet 1 of window 1") === 0,
    );
    // Return confirms the panel's default Open button.
    osa(`tell application "System Events" to tell (${proc}) to key code 36`);
    await waitUntil(
      "the folder panel to close",
      () => sheetCount("window 1") === 0,
    );
  };

  try {
    osa(`tell application "System Events" to count processes`);
  } catch (error) {
    block(`System Events is not available: ${error.message}`);
  }

  const launched = await waitFor(
    "the first window",
    (list) => list.length === 1 && list[0].name === WELCOME_TITLE,
    60_000,
  );
  if (timedOut(launched)) {
    block(`no Welcome window after launch (saw: ${describe(launched)})`);
  }

  // The first window fits the primary display's work area.
  let workArea;
  try {
    workArea = parseWorkArea(
      execFileSync("osascript", ["-l", "JavaScript", "-e", PRIMARY_WORK_AREA], {
        encoding: "utf8",
      }),
    );
  } catch (error) {
    block(
      `the primary display's work area could not be read: ${error.message}`,
    );
  }
  {
    const first = launched[0].bounds;
    const fit = firstWindowFits(first, workArea);
    check(
      "the first window takes 90% of the work area, inside it, at least the minimum size",
      fit.ok,
      `window ${JSON.stringify(first)}; work area ${JSON.stringify(workArea)}; expected content ${fit.expected.width}×${fit.expected.height}; inside ${fit.inside}, sized ${fit.sized}, 1280×760 target ${fit.target}`,
    );
  }

  // File > New Window adds one Welcome window in front.
  clickFileItem("menu.native.file.newWindow");
  const afterNew = await waitFor(
    "a second window",
    (list) => list.length === 2,
  );
  check(
    "New Window adds one window",
    !timedOut(afterNew),
    `windows: ${describe(afterNew)}`,
  );
  if (!timedOut(afterNew)) {
    check(
      "the new window is a Welcome window in front",
      frontWindow(afterNew)?.name === WELCOME_TITLE,
      `front: ${frontWindow(afterNew)?.name}`,
    );
  }

  // Open A in the new window and B in the first one.
  const names = { a: path.basename(folders.a), b: path.basename(folders.b) };
  await openWorkspace(folders.a);
  const withA = await waitFor("Workspace A", (list) =>
    list.some((window) => window.name === names.a),
  );
  if (timedOut(withA))
    block(`Workspace A did not open (saw: ${describe(withA)})`);
  raise(WELCOME_TITLE);
  await openWorkspace(folders.b);
  const withB = await waitFor(
    "Workspace B",
    (list) =>
      list.length === 2 &&
      list.some((window) => window.name === names.a) &&
      list.some((window) => window.name === names.b),
  );
  if (timedOut(withB))
    block(`Workspace B did not open (saw: ${describe(withB)})`);

  // Opening A again from B brings A's window to the front every time.
  let repeated = 0;
  let detail = "";
  for (let attempt = 1; attempt <= REPEATED_OPENS; attempt += 1) {
    raise(names.b);
    await waitFor("B in front", (list) => frontWindow(list)?.name === names.b);
    await openWorkspace(folders.a);
    const result = await waitFor(
      "A in front",
      (list) => list.length === 2 && frontWindow(list)?.name === names.a,
    );
    if (timedOut(result)) {
      detail = `attempt ${attempt}: ${describe(result)}`;
      break;
    }
    repeated = attempt;
  }
  check(
    `opening A from B ${REPEATED_OPENS} times keeps two windows and fronts A`,
    repeated === REPEATED_OPENS,
    detail || `${repeated} of ${REPEATED_OPENS}`,
  );

  // A minimized: opening it from B restores and fronts it.
  minimize(names.a);
  await waitFor("A minimized", (list) =>
    list.some((window) => window.name === names.a && window.minimized),
  );
  raise(names.b);
  await openWorkspace(folders.a);
  const restored = await waitFor(
    "A restored",
    (list) =>
      list.length === 2 &&
      frontWindow(list)?.name === names.a &&
      list.every((window) => !window.minimized),
  );
  check(
    "opening a minimized Workspace window restores and fronts it",
    !timedOut(restored),
    `windows: ${describe(restored)}`,
  );

  // A folder inside A, opened from B: A's window comes forward.
  raise(names.b);
  await waitFor("B in front", (list) => frontWindow(list)?.name === names.b);
  await openWorkspace(folders.sub);
  const revealed = await waitFor(
    "A in front for its sub-folder",
    (list) => list.length === 2 && frontWindow(list)?.name === names.a,
  );
  check(
    "opening a folder inside A fronts A's window and opens no window",
    !timedOut(revealed),
    `windows: ${describe(revealed)}`,
  );

  // A's parent folder, opened from B: B asks in the nested-Workspace dialog.
  raise(names.b);
  await waitFor("B in front", (list) => frontWindow(list)?.name === names.b);
  await openWorkspace(folders.outer);
  let buttonError = "";
  const buttons = () => {
    try {
      return parseButtonNames(osa(BUTTON_DUMP, pid, names.b));
    } catch (error) {
      buttonError = error.message.split("\n").at(-2) ?? error.message;
      return [];
    }
  };
  let seen = [];
  for (
    const deadline = Date.now() + 10_000;
    Date.now() < deadline && !hasButtons(seen, NESTED_DIALOG_BUTTONS);
    await sleep(250)
  ) {
    seen = buttons();
  }
  check(
    "opening A's parent folder asks with Close it and open here, Cancel, Switch to that window",
    hasButtons(seen, NESTED_DIALOG_BUTTONS),
    `buttons: ${seen.join(", ")}${buttonError ? `; last error: ${buttonError}` : ""}`,
  );
  if (!hasButtons(seen, NESTED_DIALOG_BUTTONS)) {
    try {
      console.log(
        osa(ROLE_DUMP, pid, names.b).split("\n").slice(0, 80).join("\n"),
      );
    } catch (error) {
      console.log(`role dump failed: ${error.message}`);
    }
  }
  const afterParent = windows();
  check(
    "the parent folder opens no window and leaves B in front",
    afterParent.length === 2 && frontWindow(afterParent)?.name === names.b,
    `windows: ${describe(afterParent)}`,
  );
  // Escape cancels the dialog.
  osa(`tell application "System Events" to tell (${proc}) to key code 53`);
  await waitUntil(
    "the dialog to close",
    () => !hasButtons(buttons(), NESTED_DIALOG_BUTTONS),
  );

  // A's window, moved and resized, then closed: opening A again shows it
  // where it was.
  raise(names.a);
  await waitFor("A in front", (list) => frontWindow(list)?.name === names.a);
  setBounds(names.a, adjustedBounds(workArea));
  await sleep(PLACEMENT_SETTLE_MS);
  const placedA = boundsOf(names.a);
  closeWindow(names.a);
  const withoutA = await waitFor("A to close", (list) => list.length === 1);
  if (timedOut(withoutA)) {
    block(`A's window did not close (saw: ${describe(withoutA)})`);
  }
  clickFileItem("menu.native.file.newWindow");
  await waitFor(
    "a Welcome window for A",
    (list) => list.length === 2 && frontWindow(list)?.name === WELCOME_TITLE,
  );
  await openWorkspace(folders.a);
  const reopenedA = await waitFor("A to reopen", (list) =>
    list.some((window) => window.name === names.a),
  );
  if (timedOut(reopenedA)) {
    block(`A did not reopen (saw: ${describe(reopenedA)})`);
  }
  // The remembered placement is applied right after the Workspace opens.
  let reopenedBounds = boundsOf(names.a);
  for (
    const deadline = Date.now() + 5_000;
    Date.now() < deadline &&
    !(placedA && reopenedBounds && sameBounds(placedA, reopenedBounds));
    await sleep(250)
  ) {
    reopenedBounds = boundsOf(names.a);
  }
  check(
    "a Workspace window reopens with the bounds it was closed with",
    placedA !== null &&
      reopenedBounds !== null &&
      sameBounds(placedA, reopenedBounds),
    `closed at ${JSON.stringify(placedA)}; reopened at ${JSON.stringify(reopenedBounds)}`,
  );

  // Drawings handed to the app: inside A, outside every Workspace, and one
  // already open.
  const deliver = async (file) => {
    if (options.app !== null) {
      execFileSync("open", ["-a", options.app, file]);
      return;
    }
    // A second launch hands its drawings to the running app and exits.
    const second = spawn(options.binary, [file], { env, stdio: "ignore" });
    children.add(second);
    await new Promise((done) => {
      second.on("exit", done);
      second.on("error", done);
      setTimeout(done, 10_000);
    });
    children.delete(second);
  };
  const via = options.app !== null ? "open -a" : "a second launch";
  const deliveredTo = async (what, file, windowName, title) => {
    await deliver(file);
    const result = await waitFor(
      what,
      (list) =>
        list.length === 2 &&
        frontWindow(list)?.name === title &&
        list.some((window) => window.name === title),
    );
    check(
      `${what} (${via})`,
      !timedOut(result),
      `expected ${windowName} in front titled “${title}”; windows: ${describe(result)}`,
    );
  };
  // A tab is titled with the file name.
  const inA = path.basename(drawings.inA);
  const alsoInA = path.basename(drawings.alsoInA);
  const outside = path.basename(drawings.outside);

  raise(names.b);
  await waitFor("B in front", (list) => frontWindow(list)?.name === names.b);
  await deliveredTo(
    "a drawing inside A opens in A's window",
    drawings.inA,
    "A",
    drawingTitle(inA, names.a),
  );
  await deliveredTo(
    "a second drawing inside A opens as another tab of A's window",
    drawings.alsoInA,
    "A",
    drawingTitle(alsoInA, names.a),
  );
  raise(names.b);
  await waitFor("B in front", (list) => frontWindow(list)?.name === names.b);
  await deliveredTo(
    "a drawing outside every Workspace opens in the most recently used window",
    drawings.outside,
    "B",
    drawingTitle(outside, names.b),
  );
  await deliveredTo(
    "a drawing already open fronts its window and switches to its tab",
    drawings.inA,
    "A",
    drawingTitle(inA, names.a),
  );

  // Observation: whether the Window menu lists every window by title.
  try {
    const items = osa(`tell application "System Events" to tell (${proc})
  set AppleScript's text item delimiters to linefeed
  return (name of every menu item of menu 1 of menu bar item "${menuItem("menu.native.window")}" of menu bar 1) as text
end tell`).split("\n");
    const titles = windows().map((window) => window.name);
    const listed = listedWindows(items, titles);
    console.log(
      `INFO the Window menu lists ${listed.length} of ${titles.length} windows — listed: ${listed.join(", ") || "none"}; items: ${items.join(", ")}`,
    );
  } catch (error) {
    console.log(`INFO the Window menu could not be read: ${error.message}`);
  }

  // Closing every window leaves the app running.
  for (let open = windows().length; open > 0; open = windows().length) {
    osa(`tell application "System Events" to tell (${proc})
  click (first button of window 1 whose subrole is "AXCloseButton")
end tell`);
    await waitFor("a window to close", (list) => list.length < open);
  }
  await sleep(2_000);
  check(
    "closing every window leaves the app running",
    windows().length === 0 && child.exitCode === null,
    `windows: ${windows().length}, exit code: ${child.exitCode}`,
  );

  // Reopen (the Dock icon, or `open -a` without a file) shows Welcome.
  if (
    checkAvailability(
      { requiresLaunchServices: true },
      { hasApp: options.app !== null },
    ) === "BLOCKED"
  ) {
    report(
      "BLOCKED",
      "Reopen without windows shows a Welcome window",
      "needs --app",
    );
  } else {
    execFileSync("open", ["-a", options.app]);
    const reopened = await waitFor(
      "a Welcome window after Reopen",
      (list) => list.length === 1 && list[0].name === WELCOME_TITLE,
    );
    check(
      "Reopen without windows shows a Welcome window",
      !timedOut(reopened),
      `windows: ${describe(reopened)}`,
    );
  }

  // Cmd+Q with an unsaved edit asks every window, then quits.
  await deliver(drawings.quit);
  const editing = await waitFor("the drawing to open", (list) =>
    list.some((window) => window.name.startsWith(path.basename(drawings.quit))),
  );
  if (timedOut(editing)) {
    block(`the drawing did not open for Cmd+Q (saw: ${describe(editing)})`);
  }
  const quitWindow = frontWindow(editing)?.name ?? "";
  // A Workspace window that a normal quit and relaunch must put back.
  clickFileItem("menu.native.file.newWindow");
  await waitFor(
    "a Welcome window for the relaunch check",
    (list) => frontWindow(list)?.name === WELCOME_TITLE,
  );
  await openWorkspace(folders.a);
  const beforeQuit = await waitFor("A for the relaunch check", (list) =>
    list.some((window) => window.name === names.a),
  );
  if (timedOut(beforeQuit)) {
    block(`A did not open before Cmd+Q (saw: ${describe(beforeQuit)})`);
  }
  setBounds(names.a, {
    ...adjustedBounds(workArea),
    x: adjustedBounds(workArea).x + 60,
  });
  await sleep(PLACEMENT_SETTLE_MS);
  const quitBounds = boundsOf(names.a);
  raise(quitWindow);
  await waitFor(
    "the drawing in front",
    (list) => frontWindow(list)?.name === quitWindow,
  );
  // Select everything and move it one step right with the keyboard.
  osa(`tell application "System Events" to tell (${proc})
  set frontmost to true
  keystroke "a" using {command down}
  key code 124
end tell`);
  // The save status reads “draft saved” once the edit is stored.
  const draftSaved = en["shell.saveStatus.draftSaved"];
  let texts = [];
  for (
    const deadline = Date.now() + 10_000;
    Date.now() < deadline && !texts.includes(draftSaved);
    await sleep(250)
  ) {
    try {
      texts = osa(STATIC_TEXT_DUMP, pid).split("\n");
    } catch {
      texts = [];
    }
  }
  check(
    "the edit reaches the drawing before Cmd+Q",
    texts.includes(draftSaved),
    `status texts: ${texts
      .filter((text) => text.trim() !== "")
      .slice(0, 12)
      .join(" | ")}`,
  );
  const exited = new Promise((done) => {
    if (child.exitCode !== null) done(child.exitCode);
    child.on("exit", (code) => done(code));
  });
  osa(`tell application "System Events" to tell (${proc})
  set frontmost to true
  keystroke "q" using {command down}
end tell`);
  const code = await Promise.race([exited, sleep(20_000).then(() => null)]);
  const saved = JSON.parse(readFileSync(drawings.quit, "utf8"));
  check(
    "Cmd+Q asks every window, then quits",
    code === 0 && quitWasCoordinated(appLog),
    `exit code: ${code}; log: ${appLog
      .split("\n")
      .filter((line) => line.includes("app-quit"))
      .join(" | ")}`,
  );
  check(
    "Cmd+Q saves the unsaved edit before quitting",
    rectangleMoved(saved),
    `rectangle on disk: ${JSON.stringify(
      (saved.elements ?? []).map(({ id, x, y }) => ({ id, x, y })),
    )}`,
  );

  // A normal quit, then a relaunch, puts A's window back where it was.
  if (code === 0) {
    const relaunched = spawn(options.binary, ["-AppleLanguages", "(en-US)"], {
      env,
      stdio: "ignore",
    });
    children.add(relaunched);
    relaunched.on("exit", () => children.delete(relaunched));
    const relaunchedPid = relaunched.pid;
    const relaunchedWindows = () =>
      parseWindowList(osa(WINDOW_DUMP, relaunchedPid));
    let restoredA = null;
    for (
      const deadline = Date.now() + 30_000;
      Date.now() < deadline &&
      !(restoredA && quitBounds && sameBounds(quitBounds, restoredA));
      await sleep(250)
    ) {
      try {
        restoredA =
          relaunchedWindows().find((window) => window.name === names.a)
            ?.bounds ?? null;
      } catch {
        // The relaunched process or its windows are not available yet.
      }
    }
    check(
      "a normal quit and relaunch restores a Workspace window's bounds",
      quitBounds !== null &&
        restoredA !== null &&
        sameBounds(quitBounds, restoredA),
      `quit at ${JSON.stringify(quitBounds)}; relaunched at ${JSON.stringify(restoredA)}`,
    );
  } else {
    report(
      "BLOCKED",
      "a normal quit and relaunch restores a Workspace window's bounds",
      "the app did not quit normally",
    );
  }

  finish(exitCodeFor(statuses));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
