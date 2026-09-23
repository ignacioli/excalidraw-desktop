import {
  HISTORY_DEFAULT_PAGE_LIMIT,
  HISTORY_MAX_PAGE_LIMIT,
  type HistoryListRequest,
  type HistoryOperationStatusRequest,
  type HistoryOperationStatusResponse,
  type HistoryReplaceRequest,
  type HistoryReplaceResponse,
  type IpcError,
} from "../ipc/contracts";
import {
  validateHistoryCommandRequest,
  type CommandInvoker,
} from "../ipc/client";
import type { HistoryClient } from "./types";

/** Raised when a replacement transport response is lost and no status is available. */
export class HistoryReplaceResponseLostError extends Error {
  readonly requestId: string;

  constructor(requestId: string, cause?: unknown) {
    super(
      `The outcome of history replacement ${requestId} could not be verified.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "HistoryReplaceResponseLostError";
    this.requestId = requestId;
  }
}

/** Raised when status proves that replacement did not reach a client-adoptable outcome. */
export class HistoryReplaceStatusError extends Error {
  readonly status: HistoryOperationStatusResponse;

  constructor(status: HistoryOperationStatusResponse) {
    super(
      `History replacement ${status.requestId} is in state ${status.state} and has no adoptable result.`,
    );
    this.name = "HistoryReplaceStatusError";
    this.status = status;
  }
}

function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<IpcError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retriable === "boolean"
  );
}

function completedResponseFromStatus(
  status: HistoryOperationStatusResponse,
): HistoryReplaceResponse | undefined {
  const newSessionGeneration = status.newSessionGeneration;
  if (
    status.state !== "completed" ||
    status.replacementCommitted !== true ||
    typeof status.protectionVersionId !== "string" ||
    status.adoptedScene === undefined ||
    typeof status.newBaseHash !== "string" ||
    typeof newSessionGeneration !== "number" ||
    !Number.isSafeInteger(newSessionGeneration) ||
    newSessionGeneration < 0
  ) {
    return undefined;
  }

  return {
    status: "completed",
    requestId: status.requestId,
    replacementCommitted: true,
    protectionVersionId: status.protectionVersionId,
    adoptedScene: status.adoptedScene,
    newBaseHash: status.newBaseHash,
    newSessionGeneration,
  };
}

function isUncertainStatus(status: HistoryOperationStatusResponse): boolean {
  return (
    status.state === "reconcile" ||
    status.state === "pendingReconciliation" ||
    status.replacementCommitted === null
  );
}

function pendingResponse(requestId: string): HistoryReplaceResponse {
  return {
    status: "pendingReconciliation",
    requestId,
    replacementCommitted: null,
    operationState: "pendingReconciliation",
  };
}

function normalizeListRequest(request: HistoryListRequest): HistoryListRequest {
  const limit = request.limit ?? HISTORY_DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > HISTORY_MAX_PAGE_LIMIT
  ) {
    throw new TypeError(
      `limit must be an integer between 1 and ${HISTORY_MAX_PAGE_LIMIT}`,
    );
  }
  // Cursor is deliberately copied without decoding or rewriting: it is an
  // opaque backend token and must remain stable across page requests.
  return { ...request, limit };
}

function validateRequest<Name extends Parameters<CommandInvoker["invoke"]>[0]>(
  command: Name,
  request: Parameters<CommandInvoker["invoke"]>[1],
): void {
  if (
    command === "history_list" ||
    command === "history_preview" ||
    command === "history_replace" ||
    command === "history_operation_status"
  ) {
    validateHistoryCommandRequest(command, request);
  }
}

export function createHistoryClient(invoker: CommandInvoker): HistoryClient {
  const operationStatus = async (
    request: HistoryOperationStatusRequest,
  ): Promise<HistoryOperationStatusResponse> => {
    validateRequest("history_operation_status", request);
    try {
      return await invoker.invoke("history_operation_status", request);
    } catch (error) {
      if (isIpcError(error)) {
        throw error;
      }
      throw new HistoryReplaceResponseLostError(request.requestId, error);
    }
  };

  const replace = async (
    request: HistoryReplaceRequest,
  ): Promise<HistoryReplaceResponse> => {
    validateRequest("history_replace", request);

    let response: HistoryReplaceResponse | undefined;
    try {
      response = await invoker.invoke("history_replace", request);
    } catch (error) {
      // A structured backend error is an actual command result, not a lost
      // response. Propagate it and never issue a second destructive command.
      if (isIpcError(error)) {
        throw error;
      }
      return await recoverReplacementOutcome(request, operationStatus, error);
    }

    if (response !== undefined) {
      return response;
    }
    // A test adapter or transport can resolve without a body. Treat that as
    // an uncertain outcome and use the idempotent status query below.
    return await recoverReplacementOutcome(request, operationStatus);
  };

  return {
    async list(request) {
      const normalized = normalizeListRequest(request);
      validateRequest("history_list", normalized);
      return invoker.invoke("history_list", normalized);
    },
    async preview(request) {
      validateRequest("history_preview", request);
      return invoker.invoke("history_preview", request);
    },
    replace,
    operationStatus,
  };
}

async function recoverReplacementOutcome(
  request: HistoryReplaceRequest,
  operationStatus: (
    request: HistoryOperationStatusRequest,
  ) => Promise<HistoryOperationStatusResponse>,
  originalError?: unknown,
): Promise<HistoryReplaceResponse> {
  let status: HistoryOperationStatusResponse;
  try {
    status = await operationStatus({
      document: request.document,
      requestId: request.requestId,
    });
  } catch (statusError) {
    // A transport failure followed by an unavailable status query is still an
    // unknown replacement outcome. Preserve both causes under the explicit
    // transport-unknown error so the coordinator can retain its freeze; typed
    // IPC errors never enter this path because replace() propagates them.
    throw new HistoryReplaceResponseLostError(request.requestId, {
      originalError,
      statusError,
    });
  }

  const completed = completedResponseFromStatus(status);
  if (completed !== undefined) {
    return completed;
  }
  if (isUncertainStatus(status)) {
    return pendingResponse(request.requestId);
  }
  throw new HistoryReplaceStatusError(status);
}
