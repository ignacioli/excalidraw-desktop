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
      | ((event: {
          payload: { command: string; validationId?: number };
        }) => void)
      | undefined;
    const unlisten = vi.fn();
    const listener: NativeMenuCommandListener = vi.fn(
      async (_eventName, handler) => {
        capturedHandler = handler;
        return unlisten;
      },
    );
    const onCommand = vi.fn();
    const emitValidationAck = vi.fn(async () => undefined);

    const cleanup = await registerNativeMenuCommand(
      onCommand,
      listener,
      emitValidationAck,
    );

    expect(listener).toHaveBeenCalledWith(
      "native-menu-command",
      expect.any(Function),
    );
    capturedHandler?.({ payload: { command: "save", validationId: 41 } });
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
    expect(emitValidationAck).toHaveBeenCalledExactlyOnceWith(
      "native-menu-validation-ack",
      { validationId: 41, command: "save" },
    );

    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does not acknowledge invalid validation identifiers or unsupported commands", async () => {
    let capturedHandler:
      | ((event: {
          payload: { command: string; validationId?: number };
        }) => void)
      | undefined;
    const listener: NativeMenuCommandListener = vi.fn(
      async (_eventName, handler) => {
        capturedHandler = handler;
        return () => undefined;
      },
    );
    const onCommand = vi.fn();
    const emitValidationAck = vi.fn(async () => undefined);

    await registerNativeMenuCommand(onCommand, listener, emitValidationAck);
    capturedHandler?.({ payload: { command: "save", validationId: 0 } });
    capturedHandler?.({ payload: { command: "quit", validationId: 42 } });

    expect(onCommand).toHaveBeenCalledExactlyOnceWith("save");
    expect(emitValidationAck).not.toHaveBeenCalled();
  });
});
