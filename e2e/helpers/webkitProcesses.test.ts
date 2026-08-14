import { describe, expect, it } from "vitest";

import {
  parseElapsedTimeMs,
  parseProcessSnapshot,
  selectOrphanedWebKitProcesses,
  type ProcessRecord,
} from "./webkitProcesses";

function record(values: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    pid: 100,
    parentPid: 1,
    rssKilobytes: 1_024,
    cpuPercent: 0.5,
    startedAtEpochMs: 10_000,
    name: "com.apple.WebKit",
    command:
      "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
    ...values,
  };
}

describe("parseElapsedTimeMs", () => {
  it("parses every documented ps etime shape", () => {
    expect(parseElapsedTimeMs("00:07")).toBe(7_000);
    expect(parseElapsedTimeMs("12:34")).toBe((12 * 60 + 34) * 1_000);
    expect(parseElapsedTimeMs("16:44:01")).toBe(
      (16 * 3_600 + 44 * 60 + 1) * 1_000,
    );
    expect(parseElapsedTimeMs("3-02:05:09")).toBe(
      (3 * 86_400 + 2 * 3_600 + 5 * 60 + 9) * 1_000,
    );
  });

  it("rejects values that are not etime shaped", () => {
    expect(parseElapsedTimeMs("")).toBeNull();
    expect(parseElapsedTimeMs("abc")).toBeNull();
    expect(parseElapsedTimeMs("123")).toBeNull();
  });
});

describe("parseProcessSnapshot", () => {
  it("derives start instants from etime and keeps command lines intact", () => {
    const snapshotAt = 1_000_000;
    const output = [
      "  3623     1  38608   0.0    16:44:01 com.apple.WebKit /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU",
      "   500   499   2048   1.5       00:07 excalidraw-desktop /tmp/bundle/excalidraw-desktop --flag value",
      "not a process line",
    ].join("\n");

    const records = parseProcessSnapshot(output, snapshotAt);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      pid: 3_623,
      parentPid: 1,
      rssKilobytes: 38_608,
      name: "com.apple.WebKit",
      startedAtEpochMs: snapshotAt - (16 * 3_600 + 44 * 60 + 1) * 1_000,
    });
    expect(records[1]).toMatchObject({
      pid: 500,
      parentPid: 499,
      command: "/tmp/bundle/excalidraw-desktop --flag value",
      startedAtEpochMs: snapshotAt - 7_000,
    });
  });
});

describe("selectOrphanedWebKitProcesses", () => {
  const window = {
    launchedAtEpochMs: 10_000,
    preexistingPids: new Set([3_623]),
  };

  it("attributes launchd-parented WebKit processes started after launch", () => {
    const started = record({ pid: 200, startedAtEpochMs: 10_500 });
    // Within the two-second slack for one-second etime granularity.
    const slack = record({ pid: 201, startedAtEpochMs: 8_500 });
    expect(
      selectOrphanedWebKitProcesses([started, slack], window),
    ).toEqual([started, slack]);
  });

  it("excludes preexisting, pre-launch, child, and non-WebKit processes", () => {
    const preexisting = record({ pid: 3_623 });
    const preLaunch = record({ pid: 202, startedAtEpochMs: 1_000 });
    const child = record({ pid: 203, parentPid: 500 });
    const unrelated = record({
      pid: 204,
      name: "some-daemon",
      command: "/usr/libexec/some-daemon",
    });
    expect(
      selectOrphanedWebKitProcesses(
        [preexisting, preLaunch, child, unrelated],
        window,
      ),
    ).toEqual([]);
  });
});
