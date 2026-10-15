import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IpcEvents } from "../ipc/contracts";
import type { TauriEventPayload } from "../ipc/events";
import { useWindowTitle } from "./useWindowTitle";

const notes = { id: "a", name: "notes", rootPath: "/Users/me/work/notes" };

describe("useWindowTitle", () => {
  it("sets the title and follows the open Workspaces of other windows", async () => {
    let announce:
      | ((event: TauriEventPayload<"open-workspaces-changed">) => void)
      | undefined;
    const listen = vi.fn(async (_name, handler) => {
      announce = handler;
      return () => undefined;
    });
    const setNativeTitle = vi.fn(async () => undefined);

    const { result } = renderHook(() =>
      useWindowTitle({
        workspace: notes,
        activeDrawing: null,
        handshake: null,
        listen,
        setNativeTitle,
      }),
    );

    expect(result.current).toBe("notes");
    expect(setNativeTitle).toHaveBeenLastCalledWith("notes");
    expect(document.title).toBe("notes");

    const payload: IpcEvents["open-workspaces-changed"] = {
      workspaces: [
        { workspaceId: "a", name: "notes", rootPath: notes.rootPath },
        { workspaceId: "b", name: "notes", rootPath: "/Users/me/home/notes" },
      ],
    };
    await act(async () => {
      announce?.({ payload });
    });

    expect(result.current).toBe("notes (work)");
    expect(setNativeTitle).toHaveBeenLastCalledWith("notes (work)");
  });
});
