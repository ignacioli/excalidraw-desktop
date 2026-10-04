import { expect, test } from "@playwright/test";
import {
  installLocalVersionHistoryHarness,
  readLocalVersionHistoryHarnessState,
} from "./localVersionHistoryHarness";

test.beforeEach(async ({ page }) => {
  await installLocalVersionHistoryHarness(page);
  await page.goto("/");
  await expect(
    page.getByRole("complementary", { name: "Version History" }),
  ).toBeVisible();
});

test("lists history with 50/100 pagination and stable semantic metadata", async ({
  page,
}) => {
  const panel = page.getByRole("complementary", { name: "Version History" });
  const rows = panel.getByRole("option");

  await expect(rows).toHaveCount(50);
  let state = await readLocalVersionHistoryHarnessState(page);
  expect(historyListLimits(state)).toEqual([50]);

  await page.getByLabel("Page size").selectOption("100");
  await expect(rows).toHaveCount(100);
  state = await readLocalVersionHistoryHarnessState(page);
  expect(historyListLimits(state)).toEqual([50, 100]);

  await expect(rows.nth(0)).toHaveAttribute("aria-label", /Automatic/);
  await expect(rows.getByText("Current", { exact: true })).toHaveCount(0);
  await expect(rows.nth(1)).toHaveAttribute("aria-label", /Manual/);
  await expect(rows.nth(1)).toHaveAttribute("aria-label", /Added title/);
  await expect(rows.nth(2)).toHaveAttribute("aria-label", /Before restore/);
  await expect(rows.nth(3)).toHaveAttribute("aria-label", /Canvas changed/);
  await expect(rows.nth(3)).toHaveAttribute("aria-label", /2025/);
  await expect(rows.nth(7)).toHaveAttribute("aria-label", /Unavailable/);
  await expect(rows.nth(0).locator("time")).toHaveAttribute(
    "datetime",
    "2025-01-01T12:00:00.000Z",
  );
});

test("supports keyboard browsing, visible focus, preview exit, and trigger focus return", async ({
  page,
}) => {
  const panel = page.getByRole("complementary", { name: "Version History" });
  const firstRow = panel.getByRole("option").first();
  await firstRow.focus();
  await page.keyboard.press("ArrowDown");

  const secondRow = panel.getByRole("option").nth(1);
  await expect(secondRow).toBeFocused();
  const focusStyle = await secondRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusStyle.outlineStyle).toBe("solid");
  expect(focusStyle.outlineWidth).not.toBe("0px");

  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("region", { name: "Read-only canvas preview" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Exit version preview" }),
  ).toBeFocused();
  await expect(panel).toContainText(
    "current drawing remains separate and unchanged",
  );

  await page.keyboard.press("Escape");
  await expect(secondRow).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open version history" }),
  ).toBeFocused();
});

test("keeps preview read-only and rejects a late response from another document tab", async ({
  page,
}) => {
  const panel = page.getByRole("complementary", { name: "Version History" });
  const lateRow = panel.getByRole("option").nth(3);
  await lateRow.focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("region", { name: "Read-only canvas preview" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Use document B" }).click();
  await page.waitForTimeout(350);
  await expect(
    panel.getByRole("region", { name: "Read-only canvas preview" }),
  ).toHaveCount(0);
  await expect(panel).toContainText("document-b.excalidraw");
  await expect(panel.getByRole("option").first()).toBeVisible();

  const state = await readLocalVersionHistoryHarnessState(page);
  expect(state.writeCommands).toEqual([]);
  expect(
    state.invocations.filter(
      (invocation) =>
        invocation.command === "history_preview" &&
        historyRequest(invocation.args).versionId === "v-003",
    ),
  ).toHaveLength(1);
  expect(
    state.invocations.some(
      (invocation) =>
        invocation.command === "history_preview" &&
        JSON.stringify(historyRequest(invocation.args).document).includes(
          "document-b",
        ),
    ),
  ).toBe(false);
  await expect(panel).not.toContainText("Read-only scene for v-003");
});

test("distinguishes loading, empty, processing, permission, conflict, unavailable, and error states", async ({
  page,
}) => {
  const panel = page.getByRole("complementary", { name: "Version History" });
  const stateSelect = page.getByLabel("State");
  const cases = [
    ["Loading", "Loading version history", "status"],
    ["Empty", "No saved versions", "status"],
    ["Processing", "Updating version history", "status"],
    ["Permission denied", "Version history access denied", "alert"],
    ["Conflict", "Version history conflict", "alert"],
    ["Resource unavailable", "Version resource unavailable", "alert"],
    ["Error", "Version history could not be loaded", "alert"],
  ] as const;
  const announcement = panel.locator(
    '.visually-hidden[role="status"][aria-live="polite"]',
  );
  await expect(announcement).toHaveCount(1);

  for (const [label, title, role] of cases) {
    await stateSelect.selectOption({ label });
    const heading = panel.getByRole("heading", { name: title, exact: true });
    const state = panel
      .getByRole(role)
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(heading).toBeVisible();
    await expect(state).toHaveCount(1);
    await expect(state).toContainText(title);
    await expect(announcement).toBeEmpty();
  }
});

test("reduces motion while preserving the visible focus contract", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const panel = page.getByRole("complementary", { name: "Version History" });
  const row = panel.getByRole("option").first();
  await expect(row).toBeVisible();
  await row.focus();
  const motion = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      transitionDuration: style.transitionDuration,
      animationDuration: style.animationDuration,
    };
  });
  expect(durationInMilliseconds(motion.transitionDuration)).toBeLessThanOrEqual(
    0.01,
  );
  expect(durationInMilliseconds(motion.animationDuration)).toBeLessThanOrEqual(
    0.01,
  );
});

function durationInMilliseconds(value: string): number {
  const numeric = Number.parseFloat(value);
  return value.endsWith("s") && !value.endsWith("ms")
    ? numeric * 1_000
    : numeric;
}

function historyListLimits(
  state: Awaited<ReturnType<typeof readLocalVersionHistoryHarnessState>>,
): number[] {
  return state.invocations
    .filter((invocation) => invocation.command === "history_list")
    .map((invocation) => Number(historyRequest(invocation.args).limit));
}

function historyRequest(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const request = args.request;
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new Error("Missing history request envelope");
  }
  return request as Record<string, unknown>;
}
