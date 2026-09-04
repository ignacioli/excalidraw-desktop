import { describe, expect, it, vi } from "vitest";
import {
  createNativeMenuCommandHandler,
  registerNativeMenuCommand,
  type NativeMenuCommandListener,
} from "./nativeMenu";

describe("registerNativeMenuCommand", () => {
  it("delegates every supported command to the frontend owners", () => {
    const onSave = vi.fn();
    const onExportImage = vi.fn();
    const onAppearance = vi.fn();
    const handler = createNativeMenuCommandHandler({
      onSave,
      onExportImage,
      onAppearance,
    });

    handler("save");
    handler("exportImage");
    handler("appearanceSystem");
    handler("appearanceLight");
    handler("appearanceDark");

    expect(onSave).toHaveBeenCalledOnce();
    expect(onExportImage).toHaveBeenCalledOnce();
    expect(onAppearance.mock.calls).toEqual([["system"], ["light"], ["dark"]]);
  });

  it("registers the native event and forwards only the supported commands", async () => {
    let capturedHandler:
      ((event: { payload: { command: string } }) => void) | undefined;
    const unlisten = vi.fn();
    const listener: NativeMenuCommandListener = vi.fn(
      async (_eventName, handler) => {
        capturedHandler = handler;
        return unlisten;
      },
    );
    const onCommand = vi.fn();

    const cleanup = await registerNativeMenuCommand(onCommand, listener);

    expect(listener).toHaveBeenCalledWith(
      "native-menu-command",
      expect.any(Function),
    );
    capturedHandler?.({ payload: { command: "save" } });
    capturedHandler?.({ payload: { command: "exportImage" } });
    capturedHandler?.({ payload: { command: "appearanceSystem" } });
    capturedHandler?.({ payload: { command: "appearanceLight" } });
    capturedHandler?.({ payload: { command: "appearanceDark" } });
    capturedHandler?.({ payload: { command: "quit" } });

    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      "save",
      "exportImage",
      "appearanceSystem",
      "appearanceLight",
      "appearanceDark",
    ]);

    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
