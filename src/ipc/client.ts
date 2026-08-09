import type { CommandName, CommandRequest, CommandResponse } from "./contracts";

export interface CommandInvoker {
  invoke<Name extends CommandName>(
    command: Name,
    request: CommandRequest<Name>,
  ): Promise<CommandResponse<Name>>;
}

export function hasTauriCommandRuntime(): boolean {
  const internals = (
    globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { invoke?: unknown };
    }
  ).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

export function createTauriCommandInvoker(): CommandInvoker {
  return {
    async invoke<Name extends CommandName>(
      command: Name,
      request: CommandRequest<Name>,
    ): Promise<CommandResponse<Name>> {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<CommandResponse<Name>>(command, request);
    },
  };
}
