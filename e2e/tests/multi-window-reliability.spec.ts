import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type TestInfo } from "@playwright/test";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  type IsolatedDesktopPaths,
} from "../helpers/app";
import {
  launchMultiWindowApp,
  type MultiWindowApp,
  type MultiWindowSnapshot,
} from "../helpers/reliability";

/**
 * Process-level multi-window reliability: a crash, a quit with a failing
 * checkpoint, a quit and restart, and closing one window. Each scenario runs
 * MULTI_WINDOW_RUNS times (10 by default) against the test-only native build
 * and attaches one JSON evidence record per run.
 */

const RUNS = Number(process.env.MULTI_WINDOW_RUNS ?? "10");
/** Longer than the coalesced Window Session write and the tab report. */
const SESSION_SETTLE_MS = 1_500;

function nativeConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    process.env.EXCALIDRAW_E2E_BINARY !== undefined
  );
}

type Position = { id: string; x: number; y: number };

interface WorkspaceFixture {
  root: string;
  file: string;
  second: string;
}

interface Fixture {
  paths: IsolatedDesktopPaths;
  alpha: WorkspaceFixture;
  beta: WorkspaceFixture;
}

function rectangle(id: string, x: number) {
  return {
    id,
    type: "rectangle",
    x,
    y: 40,
    width: 160,
    height: 100,
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
  };
}

async function writeDrawing(path: string, id: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "multi-window-reliability",
      elements: [rectangle(id, 40)],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
}

async function createWorkspace(
  paths: IsolatedDesktopPaths,
  name: string,
): Promise<WorkspaceFixture> {
  const root = join(paths.workspace, name);
  await mkdir(root, { recursive: true });
  const file = join(root, `${name}.excalidraw`);
  const second = join(root, `${name}-2.excalidraw`);
  await writeDrawing(file, `${name}-rect`);
  await writeDrawing(second, `${name}-rect-2`);
  return { root, file, second };
}

async function createFixture(): Promise<Fixture> {
  const paths = await createIsolatedDesktopPaths();
  return {
    paths,
    alpha: await createWorkspace(paths, "alpha"),
    beta: await createWorkspace(paths, "beta"),
  };
}

async function positionsOnDisk(path: string): Promise<Position[]> {
  const scene = JSON.parse(await readFile(path, "utf8")) as {
    elements: Array<Position & { isDeleted?: boolean }>;
  };
  return scene.elements
    .filter((element) => element.isDeleted !== true)
    .map(({ id, x, y }) => ({ id, x, y }));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function windowOf(snapshot: MultiWindowSnapshot, root: string) {
  return snapshot.windows.find((window) => window.workspaceRoot === root);
}

function owns(snapshot: MultiWindowSnapshot, root: string, file: string) {
  return windowOf(snapshot, root)?.documents.includes(file) === true;
}

/** Window 1 opens alpha and its drawing; a new window opens beta. */
async function openTwoWindows(
  app: MultiWindowApp,
  fixture: Fixture,
): Promise<{ alpha: string; beta: string }> {
  const first = await app.waitForSnapshot(
    (snapshot) =>
      snapshot.windows.length === 1 && snapshot.openWindows.length === 1,
  );
  const alpha = first.windows[0].label;
  await app.request(alpha, "openWorkspace", { rootPath: fixture.alpha.root });
  await app.request(alpha, "openDrawing", { path: fixture.alpha.file });
  const { label: beta } = await app.request<{ label: string }>(
    "app",
    "newWindow",
  );
  await app.request(beta, "openWorkspace", { rootPath: fixture.beta.root });
  await app.request(beta, "openDrawing", { path: fixture.beta.file });
  await app.waitForSnapshot(
    (snapshot) =>
      owns(snapshot, fixture.alpha.root, fixture.alpha.file) &&
      owns(snapshot, fixture.beta.root, fixture.beta.file),
  );
  return { alpha, beta };
}

async function edit(
  app: MultiWindowApp,
  label: string,
  path: string,
  seed: number,
): Promise<Position[]> {
  const { elements } = await app.request<{ elements: Position[] }>(
    label,
    "edit",
    { path, seed },
  );
  return elements;
}

function tabOf(
  report: Awaited<ReturnType<MultiWindowApp["report"]>>,
  path: string,
) {
  return report.tabs.find((tab) => tab.path === path);
}

/** Poll one window's report until `accept` holds. */
async function waitForReport(
  app: MultiWindowApp,
  label: string,
  accept: (report: Awaited<ReturnType<MultiWindowApp["report"]>>) => boolean,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<MultiWindowApp["report"]>> | undefined;
  while (Date.now() < deadline) {
    last = await app.report(label);
    if (accept(last)) return last;
    await delay(100);
  }
  throw new Error(
    `${label} did not reach the expected state. Last report: ${JSON.stringify(last)}`,
  );
}

interface RunEvidence {
  scenario: string;
  run: number;
  labels: Record<string, string>;
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
}

async function recordRun(
  testInfo: TestInfo,
  evidence: RunEvidence,
): Promise<void> {
  const body = JSON.stringify(evidence, null, 2);
  const name = `${evidence.scenario}-run-${String(evidence.run).padStart(2, "0")}.json`;
  await writeFile(testInfo.outputPath(name), body);
  await testInfo.attach(name, { body, contentType: "application/json" });
}

/**
 * Run `scenario` RUNS times, each on fresh isolated paths, record every
 * run's evidence, and require every check of every run to hold.
 */
async function repeat(
  testInfo: TestInfo,
  name: string,
  scenario: (fixture: Fixture, evidence: RunEvidence) => Promise<void>,
): Promise<void> {
  const failed: string[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const fixture = await createFixture();
    const evidence: RunEvidence = {
      scenario: name,
      run,
      labels: {},
      checks: {},
      details: {},
    };
    try {
      await scenario(fixture, evidence);
    } catch (error) {
      evidence.checks.completed = false;
      evidence.details.error =
        error instanceof Error ? error.message : String(error);
    } finally {
      evidence.checks.completed ??= true;
      await recordRun(testInfo, evidence);
      await cleanupIsolatedDesktopPaths(fixture.paths);
    }
    const failedChecks = Object.entries(evidence.checks)
      .filter(([, passed]) => !passed)
      .map(([check]) => check);
    if (failedChecks.length > 0) {
      failed.push(`run ${run}: ${failedChecks.join(", ")}`);
    }
  }
  expect(failed).toEqual([]);
}

/** Stop a process the scenario left running. */
async function stop(app: MultiWindowApp | undefined): Promise<void> {
  if (app !== undefined && app.running()) await app.kill();
}

test.describe("multi-window process reliability", () => {
  test.skip(
    !nativeConfigured(),
    "Requires APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at a VITE_E2E_HARNESS=1 e2e-harness build.",
  );
  test.setTimeout(RUNS * 90_000);

  test("a crash shows Recovery once for both windows before restoring them", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    await repeat(testInfo, "crash-recovery", async (fixture, evidence) => {
      let app: MultiWindowApp | undefined;
      try {
        app = await launchMultiWindowApp(fixture.paths);
        const labels = await openTwoWindows(app, fixture);
        evidence.labels = labels;
        const alphaEdit = await edit(app, labels.alpha, fixture.alpha.file, 3);
        const betaEdit = await edit(app, labels.beta, fixture.beta.file, 5);
        const before = {
          alpha: await sha256(fixture.alpha.file),
          beta: await sha256(fixture.beta.file),
        };
        await delay(SESSION_SETTLE_MS);
        await app.kill();

        app = await launchMultiWindowApp(fixture.paths);
        const recovery = await app.waitForSnapshot(
          (snapshot) => snapshot.windows.length >= 1,
        );
        const recoveryLabel = recovery.windows[0].label;
        evidence.labels.recovery = recoveryLabel;
        const dialog = await waitForReport(
          app,
          recoveryLabel,
          (report) => report.recoveryCandidates.length > 0,
        );
        const waiting = await app.snapshot();
        evidence.checks.oneRecoveryWindow =
          recovery.windows.length === 1 && recovery.windows[0].recovery;
        evidence.checks.recoveryCoversBothDrawings =
          [...dialog.recoveryCandidates].sort().join("\n") ===
          [fixture.alpha.file, fixture.beta.file].sort().join("\n");
        evidence.checks.noOtherWindowBeforeRecovery =
          waiting.openWindows.length === 1;
        evidence.checks.diskUnchangedBeforeRecovery =
          (await sha256(fixture.alpha.file)) === before.alpha &&
          (await sha256(fixture.beta.file)) === before.beta;

        const recoverAnswer = await app.send(recoveryLabel, "recover");
        if (!recoverAnswer.ok) {
          evidence.details.snapshotAtFailure = await app.snapshot();
          throw new Error(`Recovery failed: ${recoverAnswer.error ?? ""}`);
        }
        const { restored } = recoverAnswer.result as { restored: string[] };
        const after = await app.waitForSnapshot(
          (snapshot) =>
            windowOf(snapshot, fixture.alpha.root) !== undefined &&
            windowOf(snapshot, fixture.beta.root) !== undefined,
        );
        const recovered = await app.report(recoveryLabel);
        evidence.checks.bothDrawingsRestored = restored.length === 2;
        evidence.checks.restoredContentMatchesEdits =
          JSON.stringify(tabOf(recovered, fixture.alpha.file)?.elements) ===
            JSON.stringify(alphaEdit) &&
          JSON.stringify(tabOf(recovered, fixture.beta.file)?.elements) ===
            JSON.stringify(betaEdit);
        evidence.checks.sessionWindowsRestoredAfterRecovery =
          after.windows.every((window) => !window.recovery);
        evidence.checks.recoveryShownOnce = !(
          await app.snapshot()
        ).windows.some((window) => window.recovery);
        evidence.details = {
          restored,
          windowsAfterRecovery: after.windows.map(
            ({ label, workspaceRoot }) => ({ label, workspaceRoot }),
          ),
        };
      } finally {
        await stop(app);
      }
    });
  });

  test("a failing checkpoint stops the quit and a second quit succeeds", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    await repeat(
      testInfo,
      "quit-checkpoint-failure",
      async (fixture, evidence) => {
        let app: MultiWindowApp | undefined;
        try {
          app = await launchMultiWindowApp(fixture.paths);
          const labels = await openTwoWindows(app, fixture);
          evidence.labels = labels;
          const alphaEdit = await edit(
            app,
            labels.alpha,
            fixture.alpha.file,
            3,
          );
          const betaEdit = await edit(app, labels.beta, fixture.beta.file, 5);
          const betaOnDisk = await sha256(fixture.beta.file);

          await app.request("app", "setCheckpointFault", {
            label: labels.beta,
          });
          await app.request("app", "quit");
          const failed = await waitForReport(
            app,
            labels.beta,
            (report) => report.alerts.length > 0,
          );
          // The quit was cancelled, not merely delayed.
          await delay(500);
          const snapshot = await app.snapshot();
          const alpha = await app.report(labels.alpha);
          evidence.checks.processKeepsRunning = app.running();
          evidence.checks.bothWindowsStayOpen =
            snapshot.openWindows.length === 2;
          evidence.checks.failedWindowInFront = snapshot.focused.includes(
            labels.beta,
          );
          evidence.checks.failedWindowShowsError = failed.alerts.length > 0;
          evidence.checks.failedWindowKeepsEditAndDraft =
            JSON.stringify(tabOf(failed, fixture.beta.file)?.elements) ===
              JSON.stringify(betaEdit) &&
            tabOf(failed, fixture.beta.file)?.saveState !== "clean" &&
            (await sha256(fixture.beta.file)) === betaOnDisk;
          evidence.checks.otherWindowKeepsEdit =
            JSON.stringify(tabOf(alpha, fixture.alpha.file)?.elements) ===
            JSON.stringify(alphaEdit);
          evidence.details.alerts = failed.alerts;
          evidence.details.focused = snapshot.focused;

          await app.request("app", "setCheckpointFault", { label: null });
          await app.request("app", "quit");
          const exit = await app.waitForExit(20_000);
          evidence.checks.secondQuitExits =
            exit.code === 0 && exit.signal === null;
          evidence.checks.secondQuitSavedBothDrawings =
            JSON.stringify(await positionsOnDisk(fixture.alpha.file)) ===
              JSON.stringify(alphaEdit) &&
            JSON.stringify(await positionsOnDisk(fixture.beta.file)) ===
              JSON.stringify(betaEdit);
          evidence.details.exit = exit;
        } finally {
          await stop(app);
        }
      },
    );
  });

  test("a quit and restart reopens the windows, Workspaces, and tabs", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    await repeat(testInfo, "quit-restart", async (fixture, evidence) => {
      let app: MultiWindowApp | undefined;
      try {
        app = await launchMultiWindowApp(fixture.paths);
        const labels = await openTwoWindows(app, fixture);
        evidence.labels = labels;
        // Alpha has two tabs with the first one active.
        await app.request(labels.alpha, "openDrawing", {
          path: fixture.alpha.second,
        });
        await app.request(labels.alpha, "openDrawing", {
          path: fixture.alpha.file,
        });
        await waitForReport(
          app,
          labels.alpha,
          (report) =>
            report.tabs.length === 2 &&
            report.activePath === fixture.alpha.file,
        );
        await delay(SESSION_SETTLE_MS);
        await app.request("app", "quit");
        const firstExit = await app.waitForExit(20_000);
        evidence.checks.quitExits = firstExit.code === 0;

        app = await launchMultiWindowApp(fixture.paths);
        const restored = await app.waitForSnapshot(
          (snapshot) =>
            windowOf(snapshot, fixture.alpha.root) !== undefined &&
            windowOf(snapshot, fixture.beta.root) !== undefined,
        );
        const alphaLabel = windowOf(restored, fixture.alpha.root)?.label ?? "";
        const betaLabel = windowOf(restored, fixture.beta.root)?.label ?? "";
        evidence.labels.restoredAlpha = alphaLabel;
        evidence.labels.restoredBeta = betaLabel;
        const alpha = await waitForReport(
          app,
          alphaLabel,
          (report) => report.tabs.length === 2,
        );
        const beta = await waitForReport(
          app,
          betaLabel,
          (report) => report.tabs.length === 1,
        );
        evidence.checks.windowCountMatches = restored.openWindows.length === 2;
        evidence.checks.tabOrderMatches =
          alpha.tabs.map((tab) => tab.path).join("\n") ===
            [fixture.alpha.file, fixture.alpha.second].join("\n") &&
          beta.tabs.map((tab) => tab.path).join("\n") === fixture.beta.file;
        evidence.checks.activeTabMatches =
          alpha.activePath === fixture.alpha.file &&
          beta.activePath === fixture.beta.file;
        await delay(SESSION_SETTLE_MS);
        await app.request("app", "quit");
        await app.waitForExit(20_000);

        // A deleted tab file is skipped; a moved Workspace opens Welcome.
        await rm(fixture.alpha.second);
        await rename(fixture.beta.root, `${fixture.beta.root}-moved`);
        app = await launchMultiWindowApp(fixture.paths);
        const degraded = await app.waitForSnapshot(
          (snapshot) =>
            snapshot.openWindows.length === 2 &&
            windowOf(snapshot, fixture.alpha.root) !== undefined,
        );
        const degradedAlpha =
          windowOf(degraded, fixture.alpha.root)?.label ?? "";
        const welcomeLabel =
          degraded.windows.find((window) => window.label !== degradedAlpha)
            ?.label ?? "";
        evidence.labels.degradedAlpha = degradedAlpha;
        evidence.labels.welcome = welcomeLabel;
        const skipped = await waitForReport(
          app,
          degradedAlpha,
          (report) => report.tabs.length === 1 && report.alerts.length > 0,
        );
        const welcome = await waitForReport(
          app,
          welcomeLabel,
          (report) => report.welcome && report.alerts.length > 0,
        );
        evidence.checks.deletedTabSkippedWithNotice =
          skipped.tabs[0]?.path === fixture.alpha.file &&
          skipped.alerts.length > 0;
        evidence.checks.movedWorkspaceShowsWelcomeWithNotice =
          welcome.welcome &&
          welcome.alerts.length > 0 &&
          degraded.windows.find((window) => window.label === welcomeLabel)
            ?.workspaceRoot === null;
        evidence.details = {
          skippedAlerts: skipped.alerts,
          welcomeAlerts: welcome.alerts,
        };
      } finally {
        await stop(app);
      }
    });
  });

  test("a quit saves an element pasted into an empty drawing", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    await repeat(testInfo, "quit-after-paste", async (fixture, evidence) => {
      const empty = join(fixture.alpha.root, "empty.excalidraw");
      await writeFile(
        empty,
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "multi-window-reliability",
          elements: [],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
        }),
      );
      const app = await launchMultiWindowApp(fixture.paths);
      try {
        const first = await app.waitForSnapshot(
          (snapshot) =>
            snapshot.windows.length === 1 && snapshot.openWindows.length === 1,
        );
        const label = first.windows[0].label;
        evidence.labels.window = label;
        await app.request(label, "openWorkspace", {
          rootPath: fixture.alpha.root,
        });
        await app.request(label, "openDrawing", { path: empty });
        // Opening checkpoints the drawing once; paste into the settled editor.
        await waitForReport(
          app,
          label,
          (report) => tabOf(report, empty)?.saveState === "clean",
        );
        // The SDK gives pasted elements new ids; compare by count.
        const { elements } = await app.request<{ elements: Position[] }>(
          label,
          "paste",
          {
            path: empty,
            clipboardText: JSON.stringify({
              type: "excalidraw/clipboard",
              elements: [rectangle("pasted-rect", 40)],
              files: {},
            }),
          },
        );
        evidence.checks.pasteReachedDraft = elements.length === 1;
        await app.request("app", "quit");
        const exit = await app.waitForExit(20_000);
        evidence.checks.quitExits = exit.code === 0;
        const saved = await positionsOnDisk(empty);
        evidence.checks.quitSavedPaste =
          saved.length === 1 && saved[0].id === elements[0]?.id;
        evidence.details = { pasted: elements, saved };
      } finally {
        await stop(app);
      }
    });
  });

  test("closing one window saves it and leaves the other window as it was", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    await repeat(testInfo, "close-one-window", async (fixture, evidence) => {
      let app: MultiWindowApp | undefined;
      try {
        app = await launchMultiWindowApp(fixture.paths);
        const labels = await openTwoWindows(app, fixture);
        evidence.labels = labels;
        const alphaEdit = await edit(app, labels.alpha, fixture.alpha.file, 3);
        const betaEdit = await edit(app, labels.beta, fixture.beta.file, 5);
        const betaOnDisk = await sha256(fixture.beta.file);

        await app.request("app", "close", { label: labels.alpha });
        const closed = await app.waitForSnapshot(
          (snapshot) => !snapshot.openWindows.includes(labels.alpha),
        );
        const beta = await app.report(labels.beta);
        evidence.checks.closedWindowSaved =
          JSON.stringify(await positionsOnDisk(fixture.alpha.file)) ===
          JSON.stringify(alphaEdit);
        evidence.checks.closedWindowGone =
          closed.openWindows.length === 1 &&
          closed.openWindows[0] === labels.beta;
        evidence.checks.otherWindowUnchanged =
          JSON.stringify(tabOf(beta, fixture.beta.file)?.elements) ===
            JSON.stringify(betaEdit) &&
          tabOf(beta, fixture.beta.file)?.saveState !== "clean" &&
          (await sha256(fixture.beta.file)) === betaOnDisk;

        await app.request("app", "setCheckpointFault", { label: labels.beta });
        await app.request("app", "close", { label: labels.beta });
        const failed = await waitForReport(
          app,
          labels.beta,
          (report) => report.alerts.length > 0,
        );
        await delay(500);
        evidence.checks.failedCloseKeepsWindow = (
          await app.snapshot()
        ).openWindows.includes(labels.beta);
        evidence.checks.failedCloseShowsError = failed.alerts.length > 0;
        evidence.checks.failedCloseKeepsEditAndDraft =
          JSON.stringify(tabOf(failed, fixture.beta.file)?.elements) ===
            JSON.stringify(betaEdit) &&
          tabOf(failed, fixture.beta.file)?.saveState !== "clean" &&
          (await sha256(fixture.beta.file)) === betaOnDisk;
        evidence.details.alerts = failed.alerts;
      } finally {
        await stop(app);
      }
    });
  });
});
