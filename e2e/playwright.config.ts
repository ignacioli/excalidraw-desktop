import { defineConfig, devices } from "@playwright/test";

const performanceRun = process.env.PERF_TEST === "1";
const browserServerRequired =
  !performanceRun && process.env.PLAYWRIGHT_SKIP_WEBSERVER !== "1";
const browserBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:1420";
// The History panel harness is mounted only by a dev server built with
// VITE_E2E_HARNESS=1. That flag also starts the native performance driver in
// the full AppShell, which the other browser harnesses reject, so the History
// harness spec gets its own server. A reused server on this port must have been
// started with VITE_E2E_HARNESS=1 as well.
const historyHarnessBaseUrl =
  process.env.PLAYWRIGHT_HISTORY_HARNESS_BASE_URL ?? "http://127.0.0.1:1422";
const historyHarnessSpecs = ["tests/local-version-history-preview.spec.ts"];

export default defineConfig({
  testDir: ".",
  testMatch: performanceRun ? ["perf/**/*.spec.ts"] : ["tests/**/*.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  outputDir: "test-results",
  use: {
    baseURL: browserBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "browser-ui",
      testIgnore: performanceRun ? undefined : historyHarnessSpecs,
      use: { ...devices["Desktop Chrome"] },
    },
    ...(performanceRun
      ? []
      : [
          {
            name: "browser-history-harness",
            testMatch: historyHarnessSpecs,
            use: {
              ...devices["Desktop Chrome"],
              baseURL: historyHarnessBaseUrl,
            },
          },
        ]),
  ],
  webServer: browserServerRequired
    ? [
        {
          command: "pnpm dev --host 127.0.0.1",
          url: "http://127.0.0.1:1420",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "pnpm dev --host 127.0.0.1 --port 1422",
          url: "http://127.0.0.1:1422",
          env: { VITE_E2E_HARNESS: "1" },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : undefined,
});
