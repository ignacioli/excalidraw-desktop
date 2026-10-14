#!/usr/bin/env node
// Native window check for a built app (macOS): window count, titles, front
// window, bounds, and minimized state through Accessibility / System Events.
// Usage: pnpm native:window:check -- [--app PATH.app | --binary PATH].
// Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED. Brings the app to the foreground; do
// not touch the keyboard or mouse while it runs. Checks that need the app to
// be known to LaunchServices (Finder open, Dock reopen) report BLOCKED
// without --app.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/** A check that needs LaunchServices cannot run against a bare binary. */
export function checkAvailability(check, { hasApp }) {
  return check.requiresLaunchServices && !hasApp ? "BLOCKED" : "RUN";
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
  const folders = { a: path.join(root, "alpha"), b: path.join(root, "beta") };
  for (const folder of Object.values(folders)) mkdirSync(folder);

  const child = spawn(options.binary, ["-AppleLanguages", "(en-US)"], {
    env: { ...process.env, HOME: path.join(root, "home") },
    stdio: "ignore",
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

  finish(exitCodeFor(statuses));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
