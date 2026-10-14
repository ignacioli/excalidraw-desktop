import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackToast } from "./FeedbackToast";
import {
  FEEDBACK_TOAST_DURATION_MS,
  useFeedbackToast,
  type FeedbackToastInput,
} from "./feedbackToastState";

let show: (input: FeedbackToastInput) => void = () => undefined;
const exposeShow = (showToast: typeof show) => {
  show = showToast;
};

function Harness() {
  const { toast, showToast, dismissToast } = useFeedbackToast();
  useEffect(() => exposeShow(showToast), [showToast]);
  return <FeedbackToast onDismiss={dismissToast} toast={toast} />;
}

describe("FeedbackToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces success politely and disappears after about two seconds", () => {
    render(<Harness />);
    act(() =>
      show({
        tone: "success",
        message: "Path copied",
        path: "~/Drawings/a b.excalidraw",
      }),
    );

    const toast = screen.getByRole("status");
    expect(toast).toHaveAttribute("aria-live", "polite");
    expect(toast).toHaveAttribute("data-tone", "success");
    expect(toast).toHaveTextContent("Path copied");
    expect(screen.getByText("~/Drawings/a b.excalidraw")).toHaveAttribute(
      "title",
      "~/Drawings/a b.excalidraw",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(FEEDBACK_TOAST_DURATION_MS.success - 1));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a failure for six seconds and can be dismissed by hand", () => {
    render(<Harness />);
    act(() =>
      show({
        tone: "failure",
        message: "Couldn't copy path: the item no longer exists",
      }),
    );

    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "failure");
    act(() => vi.advanceTimersByTime(FEEDBACK_TOAST_DURATION_MS.failure - 1));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => show({ tone: "failure", message: "Couldn't copy path" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows at most one toast and restarts the timer when replaced", () => {
    render(<Harness />);
    act(() => show({ tone: "success", message: "Path copied" }));
    act(() => vi.advanceTimersByTime(1500));
    act(() =>
      show({
        tone: "success",
        message: "“docs” is inside Notes, already open in this window",
        durationMs: FEEDBACK_TOAST_DURATION_MS.locate,
      }),
    );

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "“docs” is inside Notes, already open in this window",
    );
    act(() => vi.advanceTimersByTime(FEEDBACK_TOAST_DURATION_MS.locate - 1));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => show({ tone: "failure", message: "Couldn't copy path" }));
    act(() => show({ tone: "success", message: "Relative path copied" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("renders nothing without a toast", () => {
    const { container } = render(
      <FeedbackToast onDismiss={vi.fn()} toast={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
