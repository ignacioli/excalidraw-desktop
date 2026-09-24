import { describe, expect, it } from "vitest";

import { formatHistoryFrontendError } from "./historyFrontendError";

describe("formatHistoryFrontendError", () => {
  it("preserves structured IPC error details for process evidence", () => {
    expect(
      formatHistoryFrontendError({
        code: "HISTORY_RESOURCE_MISSING",
        message: "History asset is missing.",
        retriable: false,
      }),
    ).toBe("HISTORY_RESOURCE_MISSING: History asset is missing.");
  });

  it("keeps Error messages and serializes other objects", () => {
    expect(formatHistoryFrontendError(new Error("frontend failed"))).toBe(
      "frontend failed",
    );
    expect(formatHistoryFrontendError({ reason: "unknown" })).toBe(
      "reason=unknown",
    );
  });

  it("retains nested transport and status-query causes", () => {
    expect(
      formatHistoryFrontendError(
        new Error("replacement could not be verified", {
          cause: {
            originalError: { code: "TRANSPORT", message: "request failed" },
            statusError: new Error("status unavailable"),
          },
        }),
      ),
    ).toBe(
      "replacement could not be verified; cause: originalError=TRANSPORT: request failed, statusError=status unavailable",
    );
  });
});
