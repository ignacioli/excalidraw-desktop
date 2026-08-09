import { expect, test, type Locator, type Page } from "@playwright/test";

const OBSERVATION_SCHEMA_VERSION = "1.0.0" as const;
const FIXTURE_FILE_COUNT = 10_000;
const BASELINE_FILE_COUNT = 1_000;
const FIXTURE_DIRECTORY = "bulk";
const FIXTURE_SEED = 58_000;
const FIRST_FIXTURE_FILE = "drawing-00000.excalidraw";
const ROW_HEIGHT_PX = 32;
const SCROLL_SAMPLE_DURATION_MS = 1_000;
const MIN_SCROLL_FPS = 50;
const EXPANSION_BUDGET_MS = 200;
const MAX_RENDERED_ROWS = 300;

interface VirtualizationObservation {
  renderedRows: number;
  totalHeightPx: number;
  scrollHeightPx: number;
  clientHeightPx: number;
  estimatedRows: number;
}

interface ScrollObservation {
  sampleDurationMs: number;
  coveredDurationMs: number;
  frameCount: number;
  observedFps: number;
  p95FrameIntervalMs: number | null;
  maximumFrameIntervalMs: number | null;
  scrollDistancePx: number;
  changedPositionCount: number;
}

interface HeapSnapshot {
  api: "performance.memory" | "measureUserAgentSpecificMemory" | "unavailable";
  reportedBytes: number | null;
  usedJSHeapSizeBytes: number | null;
  totalJSHeapSizeBytes: number | null;
  reason: string | null;
}

test("10k-file fixture stays virtualized while scrolling", async ({
  page,
  context,
}, testInfo) => {
  await installScaleHarness(page, FIXTURE_FILE_COUNT);
  await page.goto("/");

  const mount = page.getByRole("button", { name: /Mount folder/i });
  await expect(mount).toBeVisible();

  // A smaller, independently mounted fixture gives us a DOM/heap comparison
  // without changing the 10k workload or relying on a total-file-count proxy.
  const baseline = await measureBaselineFixture(context);

  await mount.click();
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Expand ${FIXTURE_DIRECTORY}` }),
  ).toBeVisible();

  const expansion = await measureExpansion(page);
  const virtualization = await collectVirtualization(tree);
  const scroll = await sampleScroll(tree);
  const heap = await readHeapSnapshot(page);

  const heapScaling = compareHeapSnapshots(
    baseline.heap,
    heap,
    BASELINE_FILE_COUNT,
    FIXTURE_FILE_COUNT,
  );
  const comparisons = {
    scrollFpsAtLeast50: scroll.observedFps >= MIN_SCROLL_FPS,
    scrollContainerIsScrollable:
      virtualization.scrollHeightPx > virtualization.clientHeightPx,
    scrollMovedDuringSample:
      scroll.changedPositionCount > 0 && scroll.scrollDistancePx > 0,
    expansionAtMost200Ms: expansion.elapsedMs <= EXPANSION_BUDGET_MS,
    tenThousandRowsRepresented:
      virtualization.estimatedRows >= FIXTURE_FILE_COUNT,
    tenThousandDomRowsVirtualized:
      virtualization.renderedRows < MAX_RENDERED_ROWS,
    domRowsIndependentOfFileCount:
      baseline.virtualization !== null &&
      baseline.virtualization.renderedRows < MAX_RENDERED_ROWS &&
      virtualization.renderedRows < MAX_RENDERED_ROWS,
  };
  const browserEvidencePasses = Object.values(comparisons).every(Boolean);

  const observation = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    workload: {
      name: "phase-5-us3-10k-file-sidebar",
      fixture: {
        generator:
          "deterministic bulk directory with lexical drawing-00000..drawing-09999 names",
        directory: FIXTURE_DIRECTORY,
        fileCount: FIXTURE_FILE_COUNT,
        seed: FIXTURE_SEED,
      },
      warmUp:
        "wait for root tree, expansion child, and virtualizer content height before sampling",
      scroll: {
        durationMs: SCROLL_SAMPLE_DURATION_MS,
        clock: "requestAnimationFrame timestamp (DOMHighResTimeStamp)",
        operation:
          "advance scrollTop through the expanded list on every animation frame",
        statistic:
          "observed frame count divided by covered rAF interval duration",
      },
      expansion: {
        clock: "performance.now()",
        start: "immediately before clicking Expand bulk",
        stop: "first expanded fixture row is visible",
        statistic: "single measured response latency",
      },
      scaling: {
        baselineFileCount: BASELINE_FILE_COUNT,
        comparedFileCount: FIXTURE_FILE_COUNT,
        domStatistic:
          "post-expansion role=treeitem count and virtualizer content height",
        heapStatistic:
          "optional browser JS heap snapshot after expansion; diagnostic only",
      },
      expectedVariance:
        "browser scheduling and compositor load can vary; repeat before assigning a bottleneck; thresholds are unchanged",
    },
    samples: {
      baseline,
      tenThousand: {
        expansion,
        virtualization,
        scroll,
        heap,
      },
    },
    statistic: {
      scroll,
      expansionMs: expansion.elapsedMs,
      virtualization,
      heapScaling,
    },
    budget: {
      minimumScrollFps: {
        value: MIN_SCROLL_FPS,
        unit: "frames per second",
        statistic:
          "rAF-derived observed FPS over a 1 second active-scroll window",
      },
      requiresScrollableViewport: {
        value: true,
        unit: "boolean",
        statistic:
          "post-expansion scrollHeight must exceed clientHeight before rAF FPS is considered scrolling evidence",
      },
      maximumExpansionMs: {
        value: EXPANSION_BUDGET_MS,
        unit: "ms",
        statistic: "performance.now from expand click to first child rendered",
      },
      maximumRenderedRows: {
        value: MAX_RENDERED_ROWS,
        unit: "DOM treeitem nodes",
        statistic: "post-expansion snapshot (virtualization guard)",
      },
    },
    verdict: {
      overall: browserEvidencePasses ? "pass" : "fail",
      scope:
        "browser-ui fixture diagnostic; fixed-runner/native process-tree verdict not evaluated",
      comparisons,
      memoryScaling: heapScaling.available
        ? "observed-diagnostic"
        : "not_evaluated",
      reason: browserEvidencePasses
        ? "SC-007 scroll, expansion, and DOM virtualization evidence passed in the browser fixture."
        : "At least one SC-007 browser fixture assertion failed.",
    },
    limitations: [
      "The harness supplies deterministic dir_list responses; it does not prove native filesystem indexing or IPC latency.",
      "Browser rAF and JS heap observations do not include Tauri/WebView/GPU process-tree RSS; fixed-runner accounting remains outside this test.",
      "Heap snapshots include the browser harness and are recorded only when a supported browser memory API is exposed; no unapproved heap threshold is inferred.",
    ],
  };

  await testInfo.attach("us3-scale-observation.json", {
    body: JSON.stringify(observation, null, 2),
    contentType: "application/json",
  });

  expect(scroll.observedFps).toBeGreaterThanOrEqual(MIN_SCROLL_FPS);
  expect(virtualization.scrollHeightPx).toBeGreaterThan(
    virtualization.clientHeightPx,
  );
  expect(scroll.changedPositionCount).toBeGreaterThan(0);
  expect(scroll.scrollDistancePx).toBeGreaterThan(0);
  expect(expansion.elapsedMs).toBeLessThanOrEqual(EXPANSION_BUDGET_MS);
  expect(virtualization.estimatedRows).toBeGreaterThanOrEqual(
    FIXTURE_FILE_COUNT,
  );
  expect(virtualization.renderedRows).toBeLessThan(MAX_RENDERED_ROWS);
  expect(
    baseline.virtualization?.renderedRows ?? MAX_RENDERED_ROWS,
  ).toBeLessThan(MAX_RENDERED_ROWS);
});

async function measureBaselineFixture(
  context: import("@playwright/test").BrowserContext,
): Promise<{
  virtualization: VirtualizationObservation | null;
  heap: HeapSnapshot;
  unavailableReason: string | null;
}> {
  const baselinePage = await context.newPage();
  try {
    await installScaleHarness(baselinePage, BASELINE_FILE_COUNT);
    await baselinePage.goto("/");
    const mount = baselinePage.getByRole("button", { name: /Mount folder/i });
    await expect(mount).toBeVisible();
    await mount.click();
    const tree = baselinePage.getByRole("tree");
    await expect(tree).toBeVisible();
    await baselinePage
      .getByRole("button", { name: `Expand ${FIXTURE_DIRECTORY}` })
      .click();
    await expect(
      baselinePage.getByRole("button", { name: `Open ${FIRST_FIXTURE_FILE}` }),
    ).toBeVisible();
    return {
      virtualization: await collectVirtualization(tree),
      heap: await readHeapSnapshot(baselinePage),
      unavailableReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      virtualization: null,
      heap: unavailableHeap(reason),
      unavailableReason: reason,
    };
  } finally {
    await baselinePage.close();
  }
}

async function measureExpansion(page: Page): Promise<{ elapsedMs: number }> {
  await page.evaluate(() => performance.mark("us3-expansion-start"));
  await page
    .getByRole("button", { name: `Expand ${FIXTURE_DIRECTORY}` })
    .click();
  await expect(
    page.getByRole("button", { name: `Open ${FIRST_FIXTURE_FILE}` }),
  ).toBeVisible();
  const elapsedMs = await page.evaluate(() => {
    const entries = performance.getEntriesByName("us3-expansion-start");
    const start = entries[entries.length - 1];
    return start === undefined
      ? Number.POSITIVE_INFINITY
      : performance.now() - start.startTime;
  });
  return { elapsedMs };
}

async function collectVirtualization(
  tree: Locator,
): Promise<VirtualizationObservation> {
  return tree.evaluate((element, rowHeight) => {
    const content = element.firstElementChild;
    const renderedRows = element.querySelectorAll("[role=treeitem]").length;
    const totalHeightPx = content?.getBoundingClientRect().height ?? 0;
    const scrollContainer = element as unknown as {
      scrollHeight: number;
      clientHeight: number;
    };
    return {
      renderedRows,
      totalHeightPx,
      scrollHeightPx: scrollContainer.scrollHeight,
      clientHeightPx: scrollContainer.clientHeight,
      estimatedRows: Math.round(totalHeightPx / rowHeight),
    };
  }, ROW_HEIGHT_PX);
}

async function sampleScroll(tree: Locator): Promise<ScrollObservation> {
  return tree.evaluate(async (element, durationMs) => {
    const scrollContainer = element as unknown as {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    };
    const intervalsMs: number[] = [];
    let firstTimestamp: number | undefined;
    let previousTimestamp: number | undefined;
    const scrollTopStart = scrollContainer.scrollTop;
    let maximumScrollDistancePx = 0;
    let changedPositionCount = 0;
    let direction = 1;
    const requestAnimationFrame = (
      globalThis as unknown as {
        requestAnimationFrame(callback: (timestamp: number) => void): number;
      }
    ).requestAnimationFrame;

    return await new Promise<ScrollObservation>((resolve) => {
      const tick = (timestamp: number) => {
        if (firstTimestamp === undefined) {
          firstTimestamp = timestamp;
          previousTimestamp = timestamp;
        } else if (previousTimestamp !== undefined) {
          intervalsMs.push(timestamp - previousTimestamp);
          previousTimestamp = timestamp;
        }

        const previousScrollTop = scrollContainer.scrollTop;
        const maximumScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );
        const delta = Math.max(1, scrollContainer.clientHeight * 0.75);
        const nextScrollTop = previousScrollTop + direction * delta;
        if (nextScrollTop >= maximumScrollTop) {
          scrollContainer.scrollTop = maximumScrollTop;
          direction = -1;
        } else if (nextScrollTop <= 0) {
          scrollContainer.scrollTop = 0;
          direction = 1;
        } else {
          scrollContainer.scrollTop = nextScrollTop;
        }
        if (scrollContainer.scrollTop !== previousScrollTop) {
          changedPositionCount += 1;
        }
        maximumScrollDistancePx = Math.max(
          maximumScrollDistancePx,
          Math.abs(scrollContainer.scrollTop - scrollTopStart),
        );

        const elapsedMs = timestamp - (firstTimestamp ?? timestamp);
        if (elapsedMs >= durationMs) {
          const coveredDurationMs = intervalsMs.reduce(
            (total, interval) => total + interval,
            0,
          );
          const sortedIntervalsMs = [...intervalsMs].sort(
            (left, right) => left - right,
          );
          const p95Index = Math.min(
            sortedIntervalsMs.length - 1,
            Math.max(0, Math.ceil(sortedIntervalsMs.length * 0.95) - 1),
          );
          resolve({
            sampleDurationMs: durationMs,
            coveredDurationMs,
            frameCount: intervalsMs.length,
            observedFps:
              coveredDurationMs > 0
                ? (intervalsMs.length * 1_000) / coveredDurationMs
                : 0,
            p95FrameIntervalMs:
              sortedIntervalsMs.length > 0 ? sortedIntervalsMs[p95Index] : null,
            maximumFrameIntervalMs:
              sortedIntervalsMs.length > 0
                ? sortedIntervalsMs[sortedIntervalsMs.length - 1]
                : null,
            scrollDistancePx: maximumScrollDistancePx,
            changedPositionCount,
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, SCROLL_SAMPLE_DURATION_MS);
}

async function readHeapSnapshot(page: Page): Promise<HeapSnapshot> {
  return page.evaluate(async () => {
    type BrowserMemory = {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
    };
    type BrowserPerformance = {
      memory?: BrowserMemory;
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    const browserPerformance = (
      globalThis as unknown as {
        performance: BrowserPerformance;
      }
    ).performance;
    let unavailableReason: string | null = null;

    if (
      typeof browserPerformance.measureUserAgentSpecificMemory === "function"
    ) {
      try {
        const result =
          await browserPerformance.measureUserAgentSpecificMemory();
        return {
          api: "measureUserAgentSpecificMemory" as const,
          reportedBytes: result.bytes,
          usedJSHeapSizeBytes: null,
          totalJSHeapSizeBytes: null,
          reason: null,
        };
      } catch (error) {
        unavailableReason =
          error instanceof Error
            ? error.message
            : "memory API rejected the measurement";
      }
    }

    const memory = browserPerformance.memory;
    if (memory !== undefined) {
      return {
        api: "performance.memory" as const,
        reportedBytes: memory.usedJSHeapSize,
        usedJSHeapSizeBytes: memory.usedJSHeapSize,
        totalJSHeapSizeBytes: memory.totalJSHeapSize,
        reason: unavailableReason,
      };
    }

    return unavailableHeap(
      unavailableReason ?? "browser memory APIs are unavailable",
    );
  });
}

function unavailableHeap(reason: string): HeapSnapshot {
  return {
    api: "unavailable",
    reportedBytes: null,
    usedJSHeapSizeBytes: null,
    totalJSHeapSizeBytes: null,
    reason,
  };
}

function compareHeapSnapshots(
  baseline: HeapSnapshot,
  expanded: HeapSnapshot,
  baselineFileCount: number,
  expandedFileCount: number,
): {
  available: boolean;
  api: HeapSnapshot["api"] | "mixed";
  baselineBytes: number | null;
  expandedBytes: number | null;
  growthBytes: number | null;
  growthPerAdditionalFileBytes: number | null;
  ratio: number | null;
  interpretation: string;
} {
  const baselineBytes = baseline.reportedBytes;
  const expandedBytes = expanded.reportedBytes;
  const available = baselineBytes !== null && expandedBytes !== null;
  const additionalFiles = expandedFileCount - baselineFileCount;
  return {
    available,
    api:
      baseline.api === expanded.api
        ? baseline.api
        : baseline.api === "unavailable" || expanded.api === "unavailable"
          ? "mixed"
          : "mixed",
    baselineBytes,
    expandedBytes,
    growthBytes: available ? expandedBytes - baselineBytes : null,
    growthPerAdditionalFileBytes:
      available && additionalFiles > 0
        ? (expandedBytes - baselineBytes) / additionalFiles
        : null,
    ratio:
      available && baselineBytes > 0 ? expandedBytes / baselineBytes : null,
    interpretation:
      "diagnostic browser heap only; no approved SC-007 heap threshold and no native process-tree RSS claim",
  };
}

async function installScaleHarness(
  page: Page,
  fileCount: number,
): Promise<void> {
  await page.addInitScript(
    ({ count, directory, seed }) => {
      type TauriInternals = {
        invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown>;
      };
      const browser = globalThis as typeof globalThis & {
        __TAURI_INTERNALS__?: TauriInternals;
      };
      let mounted = false;
      const workspace = {
        id: "workspace-1",
        name: "10k fixture",
        rootPath: "/workspace",
        createdAt: seed,
      };
      const makeFiles = () =>
        Array.from({ length: count }, (_, index) => {
          const name = `drawing-${String(index).padStart(5, "0")}.excalidraw`;
          return {
            name,
            relativePath: `${directory}/${name}`,
            kind: "file",
            mtime: seed + index,
            fileSize: 100,
          };
        });

      browser.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
          if (command === "plugin:dialog|open") return "/workspace";
          if (command === "workspace_list") return mounted ? [workspace] : [];
          if (command === "workspace_add") {
            mounted = true;
            return workspace;
          }
          if (command === "workspace_remove") {
            mounted = false;
            return {};
          }
          if (command === "dir_list") {
            const relativePath =
              typeof args.relativePath === "string" ? args.relativePath : "";
            if (relativePath === "") {
              return [
                {
                  name: directory,
                  relativePath: directory,
                  kind: "dir",
                  mtime: seed,
                  fileSize: 0,
                },
              ];
            }
            if (relativePath === directory) return makeFiles();
            return [];
          }
          throw new Error(`Unexpected scale command ${command}`);
        },
      };
    },
    { count: fileCount, directory: FIXTURE_DIRECTORY, seed: FIXTURE_SEED },
  );
}
