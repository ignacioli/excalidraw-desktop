import type { CommandName, CommandRequest, CommandResponse } from "./contracts";

export interface CommandInvoker {
  invoke<Name extends CommandName>(
    command: Name,
    request: CommandRequest<Name>,
  ): Promise<CommandResponse<Name>>;
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
