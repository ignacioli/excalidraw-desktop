import { defineConfig, devices } from "@playwright/test";

const performanceRun = process.env.PERF_TEST === "1";
const browserServerRequired =
  !performanceRun && process.env.PLAYWRIGHT_SKIP_WEBSERVER !== "1";

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
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "browser-ui",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: browserServerRequired
    ? {
        command: "pnpm dev --host 127.0.0.1",
        url: "http://127.0.0.1:1420",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
