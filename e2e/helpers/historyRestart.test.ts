// @vitest-environment node
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import * as app from "./app";
import { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  waitForHistoryFrontendEvidence,
  runTauriHistoryRestartJourney,
  HistoryRestartJourneyError,
  type HistoryFrontendCanvasEvidence,
} from "./reliability";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const expected = { requestId: "restore-a", targetVersionId: "version-a" };
const adoption: HistoryFrontendCanvasEvidence = {
  scenario: "history-frontend-adoption",
  ...expected,
  documentId: "document-1",
  historyDatabasePath: "/isolated/history.sqlite",
  adopted: true,
  canvasReadback: {
    elementIds: [],
    elementTypes: [],
    appState: {},
    assetHashes: {},
  },
};

let root: string;
let marker: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "history-ready-regression-"));
  marker = join(root, "ready.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeMarker(value: unknown): Promise<void> {
  await writeFile(marker, JSON.stringify(value));
}

describe("history frontend marker identity", () => {
  it.each([
    { requestId: "restore-b", targetVersionId: "version-b" },
    { requestId: expected.requestId, targetVersionId: "version-b" },
    { requestId: "restore-b", targetVersionId: expected.targetVersionId },
  ])("waits past a stale adoption marker %j", async (stale) => {
    await writeMarker({ ...adoption, ...stale });
    let settled = false;
    const pending = waitForHistoryFrontendEvidence(
      new ChildProcess(),
      marker,
      1_000,
      expected,
    ).then((result) => {
      settled = true;
      return result;
    });
    await delay(75);
    const consumedStaleMarker = settled;
    await writeMarker(adoption);
    const result = await pending;
    expect(consumedStaleMarker).toBe(false);
    expect(result).toEqual(adoption);
  });

  it.each([
    {},
    { requestId: "restore-b" },
    { requestId: expected.requestId, targetVersionId: "version-b" },
  ])("ignores unrelated error markers %j", async (identity) => {
    await writeMarker({
      scenario: "history-frontend-error",
      error: "old error",
      ...identity,
    });
    let settled = false;
    const pending = waitForHistoryFrontendEvidence(
      new ChildProcess(),
      marker,
      1_000,
      expected,
    ).then((result) => {
      settled = true;
      return result;
    });
    await delay(75);
    const consumedStaleMarker = settled;
    await writeMarker(adoption);
    const result = await pending;
    expect(consumedStaleMarker).toBe(false);
    expect(result).toEqual(adoption);
  });

  it.each([{ requestId: expected.requestId }, expected])(
    "returns errors belonging to this attempt %j",
    async (identity) => {
      const failure = {
        scenario: "history-frontend-error",
        error: "restore failed",
        ...identity,
      };
      await writeMarker(failure);
      await expect(
        waitForHistoryFrontendEvidence(
          new ChildProcess(),
          marker,
          1_000,
          expected,
        ),
      ).resolves.toEqual(failure);
    },
  );

  it("times out instead of accepting a stale success", async () => {
    await writeMarker({ ...adoption, requestId: "restore-b" });
    await expect(
      waitForHistoryFrontendEvidence(new ChildProcess(), marker, 60, expected),
    ).rejects.toThrow("did not arrive");
  });

  it("reports process exit even when a stale marker exists", async () => {
    await writeMarker({ ...adoption, requestId: "restore-b" });
    const child = new ChildProcess();
    child.exitCode = 1;
    await expect(
      waitForHistoryFrontendEvidence(child, marker, 1_000, expected),
    ).rejects.toThrow("process exited before evidence");
  });
});

describe("history restart failure evidence", () => {
  it("retains the root and completed frontend evidence when verification fails", async () => {
    const paths: app.IsolatedDesktopPaths = {
      root,
      data: join(root, "data"),
      config: join(root, "config"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
      workspace: join(root, "workspace"),
      temporary: join(root, "temporary"),
    };
    const readyPath = join(
      paths.runtime,
      "reliability",
      "history-frontend.ready.json",
    );
    await mkdir(join(paths.runtime, "reliability"), { recursive: true });
    await writeFile(readyPath, "stale marker must be removed before launch");
    vi.spyOn(app, "resolveDesktopBinary").mockResolvedValue(
      "/mock/native-binary",
    );
    vi.spyOn(app, "createIsolatedDesktopPaths").mockResolvedValue(paths);
    const cleanup = vi.spyOn(app, "cleanupIsolatedDesktopPaths");
    const seed = {
      scenario: "history-restart-seed",
      versionAId: "version-a",
      versionBId: "version-b",
    };
    const frontendB = {
      ...adoption,
      requestId: "history-restart-b",
      targetVersionId: "version-b",
    };
    let launches = 0;
    let markerRemovedBeforeLaunch = false;
    let publish: Promise<void> | undefined;
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      const child = new ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      const launch = launches++;
      if (launch === 1) {
        publish = (async () => {
          try {
            await readFile(readyPath);
          } catch (error) {
            markerRemovedBeforeLaunch =
              (error as NodeJS.ErrnoException).code === "ENOENT";
          }
          await writeFile(readyPath, JSON.stringify(frontendB));
        })();
      } else {
        queueMicrotask(() => {
          if (launch === 0) stdout.write(JSON.stringify(seed));
          else stderr.write("HistoryStaleDocument: injected verify failure");
          child.emit("close", launch === 0 ? 0 : 1);
        });
      }
      return child;
    });
    const failure = await runTauriHistoryRestartJourney().catch(
      (error: unknown) => error,
    );
    await publish;
    expect(failure).toBeInstanceOf(HistoryRestartJourneyError);
    if (!(failure instanceof HistoryRestartJourneyError))
      throw new Error("Expected retained journey failure");
    expect(failure.stage).toBe("verifyB");
    expect(failure.paths).toEqual(paths);
    expect(failure.evidence).toEqual({ seed, frontendB });
    expect(failure.message).toContain(root);
    expect(failure.message).toContain("HistoryStaleDocument");
    expect(markerRemovedBeforeLaunch).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(readyPath, "utf8"))).toEqual(frontendB);
    const report = JSON.parse(
      await readFile(join(root, "history-restart-failure.json"), "utf8"),
    );
    expect(report).toMatchObject({
      stage: "verifyB",
      paths,
      evidence: { seed, frontendB },
    });
  });
});
