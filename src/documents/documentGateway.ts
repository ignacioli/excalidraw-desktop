import type {
  CheckpointReason,
  CommandResponse,
  HistoryOperationStatusRequest,
  HistoryOperationStatusResponse,
  HistoryReplaceRequest,
  HistoryReplaceResponse,
} from "../ipc/contracts";
import type { CommandInvoker } from "../ipc/client";

export interface DocumentGateway {
  open(path: string): Promise<CommandResponse<"doc_open">>;
  saveDraft(
    path: string,
    sceneJson: string,
  ): Promise<CommandResponse<"doc_save_draft">>;
  checkpoint(
    path: string,
    sceneJson: string,
    reason: CheckpointReason,
  ): Promise<CommandResponse<"doc_checkpoint">>;
  resolveConflict(
    path: string,
    resolution: "takeExternal" | "keepLocal" | "saveAsNew",
    saveAsPath?: string,
  ): Promise<CommandResponse<"doc_resolve_conflict">>;
  historyReplace?(
    request: HistoryReplaceRequest,
  ): Promise<HistoryReplaceResponse>;
  historyOperationStatus?(
    request: HistoryOperationStatusRequest,
  ): Promise<HistoryOperationStatusResponse>;
  close(path: string, mode: "checkpointed" | "discardOrphan"): Promise<void>;
}

export function createDocumentGateway(
  invoker: CommandInvoker,
): DocumentGateway {
  return {
    open: (path) => invoker.invoke("doc_open", { path }),
    saveDraft: (path, sceneJson) =>
      invoker.invoke("doc_save_draft", { path, sceneJson }),
    checkpoint: (path, sceneJson, reason) =>
      invoker.invoke("doc_checkpoint", { path, sceneJson, reason }),
    resolveConflict: (path, resolution, saveAsPath) =>
      invoker.invoke("doc_resolve_conflict", {
        path,
        resolution,
        ...(saveAsPath === undefined ? {} : { saveAsPath }),
      }),
    historyReplace: (request) => invoker.invoke("history_replace", request),
    historyOperationStatus: (request) =>
      invoker.invoke("history_operation_status", request),
    async close(path, mode) {
      await invoker.invoke("doc_close", { path, mode });
    },
  };
}
