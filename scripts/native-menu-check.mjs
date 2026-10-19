#!/usr/bin/env node
// Native menu check for a built app (macOS): structure, labels, enabled and
// check state through Accessibility, plus exactly-once routing per click and
// per Command-S. Usage: pnpm native:menu:check -- --languages "(en-US, zh-Hans)"
// [--binary PATH]. Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED. Brings the app to the
// foreground; do not touch the keyboard or mouse while it runs.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/messages/en.ts";
import { es } from "../src/i18n/messages/es.ts";
import { ja } from "../src/i18n/messages/ja.ts";
import { zhCN } from "../src/i18n/messages/zh-CN.ts";
import { resolveLanguage } from "../src/i18n/resolveLanguage.ts";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const languages = arg("--languages");
const binary = arg("--binary", "src-tauri/target/debug/excalidraw-desktop");
const LOG_PREFIX = "EXCALIDRAW_NATIVE_MENU_VALIDATION ";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const children = new Set();
const cleanups = [];
const block = (reason) => {
  console.log(`BLOCKED ${reason}`);
  // Never leave a launched app behind: it would capture the next launch.
  for (const child of children) child.kill("SIGKILL");
  for (const cleanup of cleanups) cleanup();
  process.exit(2);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const osa = (script) =>
  execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
const CATALOGS = { en, "zh-CN": zhCN, es, ja };
const label = (lang, key) =>
  (CATALOGS[lang] ?? en)[key].replaceAll("{name}", "Excalidraw");

let appleLanguages;
let root;

/**
 * Call `onRoute` with each validation record the app logs to `stream`.
 * Records are read whole lines at a time, so a record split across stream
 * chunks is parsed once complete.
 */
export function readValidationRoutes(stream, onRoute) {
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
    if (line.startsWith(LOG_PREFIX))
      onRoute(JSON.parse(line.slice(LOG_PREFIX.length)));
  });
}

function launch(files) {
  const child = spawn(binary, [...files, "-AppleLanguages", languages], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      EXCALIDRAW_NATIVE_MENU_VALIDATION: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.routes = [];
  readValidationRoutes(child.stderr, (route) => child.routes.push(route));
  child.on("error", (error) =>
    block(`cannot launch ${binary}: ${error.message}`),
  );
  return child;
}

const proc = (pid) => `first process whose unix id is ${pid}`;
// Item rows: depth, name, enabled, AXMenuItemMarkChar. Starts at the app menu.
const MENU_DUMP = `on rowText(d, n, e, m)
  if n is missing value then set n to ""
  if m is missing value then set m to ""
  return "I" & tab & d & tab & n & tab & e & tab & m
end rowText
on run argv
  set pidValue to (item 1 of argv) as integer
  -- Item 1 (the Apple menu) holds personal recent items; never read it.
  set out to {}
  tell application "System Events" to tell (first process whose unix id is pidValue)
    repeat with b from 2 to count of menu bar items of menu bar 1
      set mb to menu bar item b of menu bar 1
      set end of out to "M" & tab & (name of mb)
      if exists menu 1 of mb then
        set m1 to menu 1 of mb
        repeat with i from 1 to count of menu items of m1
          set mi to menu item i of m1
          set mk to missing value
          try
            set mk to value of attribute "AXMenuItemMarkChar" of mi
          end try
          set end of out to my rowText(1, name of mi, enabled of mi, mk)
          if exists menu 1 of mi then
            set m2 to menu 1 of mi
            repeat with j from 1 to count of menu items of m2
              set si to menu item j of m2
              set sk to missing value
              try
                set sk to value of attribute "AXMenuItemMarkChar" of si
              end try
              set end of out to my rowText(2, name of si, enabled of si, sk)
            end repeat
          end if
        end repeat
      end if
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run`;
function readMenu(pid) {
  const raw = execFileSync("osascript", ["-e", MENU_DUMP, String(pid)], {
    encoding: "utf8",
  }).trim();
  const menus = [{ name: "Apple", items: [] }];
  for (const line of raw.split("\n")) {
    const [kind, depth, name, enabled, mark] = line.split("\t");
    if (kind === "M") menus.push({ name: depth, items: [] });
    else if (depth === "1")
      menus.at(-1).items.push({
        name,
        enabled: enabled === "true",
        checked: mark !== "",
        children: [],
      });
    else
      menus
        .at(-1)
        .items.at(-1)
        ?.children.push({
          name,
          enabled: enabled === "true",
          checked: mark !== "",
        });
  }
  return menus;
}

async function waitFor(what, read, ready, timeoutMs = 60_000) {
  for (
    const deadline = Date.now() + timeoutMs;
    Date.now() < deadline;
    await sleep(500)
  ) {
    try {
      const value = read();
      if (ready(value)) return value;
    } catch {
      // The process or its menu bar is not available yet.
    }
  }
  block(`timed out waiting for ${what}`);
}

// Ordered subsequence match; extra items (system-injected) are only reported.
function compare(scope, actual, expected) {
  let cursor = 0;
  for (const want of expected) {
    const index = actual.findIndex(
      (item, i) => i >= cursor && item.name === want.name,
    );
    if (index < 0) {
      check(`${scope} > ${want.name}`, false, "missing");
      continue;
    }
    const extras = actual
      .slice(cursor, index)
      .map((item) => item.name)
      .filter(Boolean);
    if (extras.length > 0)
      console.log(`NOTE ${scope}: unmanaged items ${JSON.stringify(extras)}`);
    cursor = index + 1;
    const got = actual[index];
    const bad = ["enabled", "checked"].filter(
      (key) => key in want && want[key] !== got[key],
    );
    check(
      `${scope} > ${want.name}`,
      bad.length === 0,
      bad.map((key) => `${key}=${got[key]}`).join(" "),
    );
    if (want.children)
      compare(`${scope} > ${want.name}`, got.children, want.children);
  }
  const trailing = actual
    .slice(cursor)
    .map((item) => item.name)
    .filter(Boolean);
  if (trailing.length > 0)
    console.log(`NOTE ${scope}: unmanaged items ${JSON.stringify(trailing)}`);
}

const LANGUAGES = ["system", "en", "zh-CN", "es", "ja"];
const APPEARANCES = ["system", "light", "dark"];
const PREFS = ["toolLock", "grid", "snap", "zen", "viewMode"];
const COMMAND = {
  toolLock: "toggleToolLock",
  grid: "toggleGrid",
  snap: "toggleSnap",
  zen: "toggleZen",
  viewMode: "toggleViewMode",
  system: "System",
  light: "Light",
  dark: "Dark",
  en: "En",
  "zh-CN": "ZhCn",
  es: "Es",
  ja: "Ja",
};
const langLabel = (lang, value) =>
  label(
    lang,
    {
      system: "menu.native.app.languageSystem",
      en: "language.autonym.en",
      "zh-CN": "language.autonym.zhCN",
      es: "language.autonym.es",
      ja: "language.autonym.ja",
    }[value],
  );
const appearanceLabel = (lang, value) =>
  label(
    lang,
    `menu.native.view.appearance${value[0].toUpperCase()}${value.slice(1)}`,
  );
const marked = (items) => items.findIndex((item) => item.checked);
const languageItems = (menus) =>
  menus[1].items.find((item) => item.children.length === LANGUAGES.length)
    ?.children ?? [];

function expectedMenu(lang, language, appearance, hasDocument) {
  const L = (key) => label(lang, `menu.native.${key}`);
  const pref = (key) => ({
    name: L(`view.${key}`),
    enabled: hasDocument,
    checked: false,
  });
  return [
    [
      "App",
      [
        { name: L("app.about") },
        {
          name: L("app.language"),
          children: LANGUAGES.map((v) => ({
            name: langLabel(lang, v),
            checked: v === language,
          })),
        },
        { name: L("app.services") },
        { name: L("app.hide") },
        { name: L("app.hideOthers") },
        { name: L("app.quit") },
      ],
    ],
    [
      L("file"),
      [
        { name: L("file.newWindow") },
        { name: L("file.openWorkspace") },
        { name: L("file.save"), enabled: hasDocument },
        { name: L("file.exportImage") },
        { name: L("file.versionHistory") },
      ],
    ],
    [
      L("edit"),
      ["undo", "redo", "cut", "copy", "paste", "selectAll"].map((key) => ({
        name: L(`edit.${key}`),
      })),
    ],
    [
      L("view"),
      [
        {
          name: L("view.appearance"),
          children: APPEARANCES.map((v) => ({
            name: appearanceLabel(lang, v),
            checked: v === appearance,
          })),
        },
        ...["toolLock", "grid", "snap", "zen", "viewMode"].map(pref),
        { name: L("view.fullscreen") },
      ],
    ],
    // On macOS Close Window lives only in Window (unchanged from before).
    [
      L("window"),
      [
        { name: L("window.minimize") },
        { name: L("window.zoom") },
        { name: L("file.closeWindow") },
      ],
    ],
    [L("help"), [{ name: L("help.excalidrawHelp"), enabled: hasDocument }]],
  ];
}

async function round(files, hasDocument) {
  const child = launch(files);
  const pid = child.pid;
  try {
    const menus = await waitFor(
      "the synced menu",
      () => readMenu(pid),
      (m) =>
        m.length >= 7 &&
        marked(languageItems(m)) >= 0 &&
        (!hasDocument || m[2].items[0]?.enabled),
    );
    const language = LANGUAGES[marked(languageItems(menus))];
    const appearance = APPEARANCES[marked(menus[4].items[0].children)];
    const lang = resolveLanguage(language, appleLanguages);
    console.log(
      `INFO ${hasDocument ? "document" : "no-document"} round: preference ${language} → ${lang}, appearance ${appearance}`,
    );
    expectedMenu(lang, language, appearance, hasDocument).forEach(
      ([name, items], i) => {
        const actual = menus[i + 1];
        if (i > 0)
          check(`menu bar ${i + 2}`, actual.name === name, actual.name);
        compare(i === 0 ? "App" : name, actual.items, items);
      },
    );
    if (hasDocument) await routes(child, language, appearance);
  } finally {
    child.kill("SIGTERM");
    await sleep(1_000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function act(child, name, command, times, action) {
  const count = (stage) =>
    child.routes.filter((r) => r.stage === stage && r.command === command)
      .length;
  const before = [count("nativeEntry"), count("applicationRoute")];
  action();
  for (
    let waited = 0;
    waited < 6_000 && count("applicationRoute") - before[1] < times;
    waited += 250
  )
    await sleep(250);
  await sleep(400);
  const delta = [
    count("nativeEntry") - before[0],
    count("applicationRoute") - before[1],
  ];
  check(
    `route ${name}`,
    delta[0] === times && delta[1] === times,
    `nativeEntry ${delta[0]}, applicationRoute ${delta[1]}, expected ${times}`,
  );
}

async function routes(child, language, appearance) {
  const p = proc(child.pid);
  osa(`tell application "System Events" to tell ${p} to set frontmost to true`);
  await sleep(500);
  let lang = resolveLanguage(language, appleLanguages);
  const click = (bar, path) => () =>
    osa(
      `tell application "System Events" to tell ${p} to click ${path
        .map((name) => `menu item "${name}" of menu 1 of `)
        .reverse()
        .join("")}menu bar item ${bar} of menu bar 1`,
    );
  const L = (key) => label(lang, `menu.native.${key}`);
  for (const pref of PREFS) {
    for (const state of ["on", "off"])
      await act(
        child,
        `${pref} ${state}`,
        COMMAND[pref],
        1,
        click(5, [L(`view.${pref}`)]),
      );
  }
  for (const value of [
    ...APPEARANCES.filter((v) => v !== appearance),
    appearance,
  ]) {
    await act(
      child,
      `appearance ${value}`,
      `appearance${COMMAND[value]}`,
      1,
      click(5, [L("view.appearance"), appearanceLabel(lang, value)]),
    );
  }
  for (const value of [...LANGUAGES.filter((v) => v !== language), language]) {
    await act(
      child,
      `language ${value}`,
      `language${COMMAND[value]}`,
      1,
      click(2, [L("app.language"), langLabel(lang, value)]),
    );
    lang = resolveLanguage(value, appleLanguages);
    await waitFor(
      "the relabelled menu",
      () => readMenu(child.pid),
      (m) => m[2].name === L("file"),
    );
  }
  await act(child, "Command-S ×20", "save", 20, () =>
    osa(`tell application "System Events" to tell ${p}
  set frontmost to true
  repeat 20 times
    keystroke "s" using command down
    delay 0.15
  end repeat
end tell`),
  );
  for (const [name, command, bar, key] of [
    ["Save", "save", 3, "file.save"],
    ["Export Image", "exportImage", 3, "file.exportImage"],
    ["Version History", "versionHistory", 3, "file.versionHistory"],
    ["Help", "help", 7, "help.excalidrawHelp"],
  ]) {
    await act(child, name, command, 1, click(bar, [L(key)]));
  }
}

async function main() {
  if (languages === undefined) block("--languages is required");
  try {
    execFileSync("pgrep", ["-x", "excalidraw-desktop"]);
    block("an Excalidraw instance is already running");
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  appleLanguages = languages
    .replace(/[()\s]/gu, "")
    .split(",")
    .filter(Boolean);
  root = mkdtempSync(join(tmpdir(), "native-menu-check-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  try {
    await round([], false);
    const fixture = join(root, "native-menu-check.excalidraw");
    writeFileSync(
      fixture,
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "native-menu-check",
        elements: [],
        appState: {},
        files: {},
      }),
    );
    await round([fixture], true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(
    failed === 0
      ? `PASS ${results.length} checks`
      : `FAIL ${failed} of ${results.length} checks`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
