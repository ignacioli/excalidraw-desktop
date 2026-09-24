import {
  HISTORY_MAX_CURSOR_LENGTH,
  HISTORY_MAX_IDENTIFIER_LENGTH,
  HISTORY_MAX_PAGE_LIMIT,
  HISTORY_MAX_PATH_LENGTH,
  HISTORY_MAX_SCENE_BYTES,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  type HistoryCommandName,
} from "./contracts";

export type HistoryCommandRequest = CommandRequest<HistoryCommandName>;

// History list/preview and protected replacement/status are available on the
// v3 backend. Manual mark and deletion remain typed but reserved.

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${field} must be a non-empty string without NUL`);
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  return requireString(value, field, HISTORY_MAX_IDENTIFIER_LENGTH);
}

function requireLocator(value: unknown): void {
  if (!isRecord(value) || (value.kind !== "path" && value.kind !== "handle")) {
    throw new TypeError("document must be a path or opaque handle locator");
  }
  if (value.kind === "path") {
    requireString(value.path, "document.path", HISTORY_MAX_PATH_LENGTH);
  } else {
    requireIdentifier(value.documentId, "document.documentId");
  }
}

function requireSceneJson(value: unknown, field: string): string {
  const sceneJson = requireString(value, field, HISTORY_MAX_SCENE_BYTES);
  const encodedLength = new TextEncoder().encode(sceneJson).byteLength;
  if (encodedLength > HISTORY_MAX_SCENE_BYTES) {
    throw new TypeError(`${field} exceeds the supported scene size`);
  }
  return sceneJson;
}

function requireRequestId(value: unknown): string {
  return requireIdentifier(value, "requestId");
}

function requireVersionId(value: unknown): string {
  return requireIdentifier(value, "versionId");
}

function requireGeneration(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function requireHash(value: unknown, field: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hex digest`);
  }
}

function requireRequestObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("history request must be an object");
  }
  return value;
}

/**
 * Validates history command inputs before crossing the frontend trust
 * boundary. Rust must repeat these checks; this helper only rejects obvious
 * malformed calls and does not authorize a document or version.
 */
export function validateHistoryCommandRequest(
  command: HistoryCommandName,
  request: unknown,
): void {
  const value = requireRequestObject(request);
  requireLocator(value.document);

  switch (command) {
    case "history_list": {
      if (value.cursor !== undefined) {
        requireString(value.cursor, "cursor", HISTORY_MAX_CURSOR_LENGTH);
      }
      if (value.limit !== undefined) {
        if (
          typeof value.limit !== "number" ||
          !Number.isSafeInteger(value.limit) ||
          value.limit < 1 ||
          value.limit > HISTORY_MAX_PAGE_LIMIT
        ) {
          throw new TypeError(
            `limit must be an integer between 1 and ${HISTORY_MAX_PAGE_LIMIT}`,
          );
        }
      }
      return;
    }
    case "history_preview":
      requireVersionId(value.versionId);
      return;
    case "history_mark":
      requireRequestId(value.requestId);
      requireGeneration(value.sessionGeneration, "sessionGeneration");
      requireGeneration(value.revision, "revision");
      requireSceneJson(value.currentSceneJson, "currentSceneJson");
      return;
    case "history_replace": {
      requireRequestId(value.requestId);
      requireGeneration(value.sessionGeneration, "sessionGeneration");
      requireGeneration(value.revision, "revision");
      requireHash(value.expectedBaseHash, "expectedBaseHash");
      requireSceneJson(value.currentSceneJson, "currentSceneJson");
      if (!isRecord(value.target)) {
        throw new TypeError("target must be a tagged history replacement");
      }
      if (
        value.target.kind !== "restore" &&
        value.target.kind !== "clear" &&
        value.target.kind !== "import"
      ) {
        throw new TypeError("target.kind is not supported");
      }
      if (value.target.kind === "restore") {
        requireVersionId(value.target.versionId);
      } else if (value.target.kind === "import") {
        requireSceneJson(value.target.candidateSceneJson, "candidateSceneJson");
      }
      return;
    }
    case "history_operation_status":
      requireRequestId(value.requestId);
      return;
    case "history_delete":
      requireRequestId(value.requestId);
      requireVersionId(value.versionId);
      return;
  }
}

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
      // Preserve the generic command/request pair for Tauri's InvokeArgs
      // constraint while validating a narrowed history view below.
      const commandForInvoke = command;
      const requestForInvoke = request;
      if (isHistoryCommand(commandForInvoke)) {
        validateHistoryCommandRequest(commandForInvoke, requestForInvoke);
      }
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<CommandResponse<Name>>(
        commandForInvoke,
        (isHistoryCommand(commandForInvoke)
          ? { request: requestForInvoke }
          : requestForInvoke) as Record<string, unknown>,
      );
    },
  };
}

function isHistoryCommand(command: CommandName): command is HistoryCommandName {
  return command.startsWith("history_");
}
