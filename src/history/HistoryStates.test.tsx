import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryStateView } from "./HistoryStates";

describe("HistoryStateView", () => {
  it.each([
    ["loading", "Loading version history", "status"],
    ["empty", "No saved versions", "status"],
    ["processing", "Updating version history", "status"],
    ["permissionDenied", "Version history access denied", "alert"],
    ["conflict", "Version history conflict", "alert"],
    ["resourceUnavailable", "Version resource unavailable", "alert"],
    ["error", "Version history could not be loaded", "alert"],
  ] as const)(
    "renders the %s state with an accessible announcement",
    (state, title, role) => {
      render(<HistoryStateView state={state} />);

      const region = screen.getByRole(role);
      expect(region).toHaveTextContent(title);
      expect(region).toHaveAttribute(
        "aria-live",
        role === "alert" ? "assertive" : "polite",
      );
    },
  );

  it("allows the caller to provide an error message and retry action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <HistoryStateView
        message="The history database is temporarily unavailable."
        onRetry={onRetry}
        retryLabel="Retry history"
        state="error"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The history database is temporarily unavailable.",
    );
    await user.click(screen.getByRole("button", { name: "Retry history" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
