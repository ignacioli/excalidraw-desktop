import { defaultEventListener, type EventListener } from "../ipc/events";
import type { EventPayload, NativeMenuCommand } from "../ipc/contracts";

export type { NativeMenuCommand } from "../ipc/contracts";

export type NativeMenuCommandListener = EventListener<"native-menu-command">;
export type NativeMenuCommandHandler = (command: NativeMenuCommand) => void;

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
): Promise<() => void> {
  return listener("native-menu-command", (event) => {
    const command = (event.payload as EventPayload<"native-menu-command">)
      .command;
    if (isNativeMenuCommand(command)) {
      handler(command);
    }
  });
}
