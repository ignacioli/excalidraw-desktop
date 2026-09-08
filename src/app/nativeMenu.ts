import { defaultEventListener, type EventListener } from "../ipc/events";
import type { EventPayload, NativeMenuCommand } from "../ipc/contracts";

export type { NativeMenuCommand } from "../ipc/contracts";

export type NativeMenuCommandListener = EventListener<"native-menu-command">;
export type NativeMenuCommandHandler = (command: NativeMenuCommand) => void;
export type NativeMenuValidationEmitter = (
  eventName: "native-menu-validation-ack",
  payload: { validationId: number; command: NativeMenuCommand },
) => Promise<void>;

export interface NativeMenuCommandActions {
  onSave: () => void;
  onExportImage: () => void;
  onAppearance: (mode: "system" | "light" | "dark") => void;
}

const nativeMenuCommands: readonly NativeMenuCommand[] = [
  "save",
  "exportImage",
  "appearanceSystem",
  "appearanceLight",
  "appearanceDark",
];

function isNativeMenuCommand(value: unknown): value is NativeMenuCommand {
  return (
    typeof value === "string" &&
    nativeMenuCommands.includes(value as NativeMenuCommand)
  );
}

async function defaultNativeMenuValidationEmitter(
  eventName: "native-menu-validation-ack",
  payload: { validationId: number; command: NativeMenuCommand },
): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(eventName, payload);
}

function isValidationId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function createNativeMenuCommandHandler({
  onSave,
  onExportImage,
  onAppearance,
}: NativeMenuCommandActions): NativeMenuCommandHandler {
  return (command) => {
    switch (command) {
      case "save":
        onSave();
        break;
      case "exportImage":
        onExportImage();
        break;
      case "appearanceSystem":
        onAppearance("system");
        break;
      case "appearanceLight":
        onAppearance("light");
        break;
      case "appearanceDark":
        onAppearance("dark");
        break;
    }
  };
}

export function registerNativeMenuCommand(
  handler: NativeMenuCommandHandler,
  listener: NativeMenuCommandListener = defaultEventListener,
  emitValidationAck: NativeMenuValidationEmitter = defaultNativeMenuValidationEmitter,
): Promise<() => void> {
  return listener("native-menu-command", (event) => {
    const payload = event.payload as EventPayload<"native-menu-command">;
    const { command, validationId } = payload;
    if (isNativeMenuCommand(command)) {
      handler(command);
      if (isValidationId(validationId)) {
        void emitValidationAck("native-menu-validation-ack", {
          validationId,
          command,
        }).catch((error: unknown) => {
          console.error(
            "Failed to record native menu validation acknowledgement.",
            error,
          );
        });
      }
    }
  });
}
