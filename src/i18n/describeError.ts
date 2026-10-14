import type { ErrorCode } from "../ipc/contracts";
import { t, type MessageKey, type MessageParams } from "./index";

/** A user-facing frontend error; its message key is translated on display. */
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly params?: MessageParams;

  constructor(key: MessageKey, params?: MessageParams, options?: ErrorOptions) {
    super(key, options);
    this.name = "LocalizedError";
    this.key = key;
    this.params = params;
  }
}

/** Carries text that is already user-facing in the current UI language. */
export class DescribedError extends Error {
  constructor(described: string) {
    super(described);
    this.name = "DescribedError";
  }
}

const ERROR_CODE_KEYS: Readonly<Record<ErrorCode, MessageKey>> = {
  PATH_ACCESS_DENIED: "error.PATH_ACCESS_DENIED",
  WORKSPACE_NOT_FOUND: "error.WORKSPACE_NOT_FOUND",
  WORKSPACE_MOUNTED: "error.WORKSPACE_MOUNTED",
  WORKSPACE_OVERLAP: "error.WORKSPACE_OVERLAP",
  WORKSPACE_NOT_OWNED: "error.WORKSPACE_NOT_OWNED",
  INVALID_NAME: "error.INVALID_NAME",
  NAME_CONFLICT: "error.NAME_CONFLICT",
  ENTRY_PROTECTED: "error.ENTRY_PROTECTED",
  DIRECTORY_NOT_EMPTY: "error.DIRECTORY_NOT_EMPTY",
  ENTRY_CHANGED: "error.ENTRY_CHANGED",
  FILE_NOT_FOUND: "error.FILE_NOT_FOUND",
  FILE_CORRUPTED: "error.FILE_CORRUPTED",
  FILE_TOO_LARGE: "error.FILE_TOO_LARGE",
  INVALID_SCENE: "error.INVALID_SCENE",
  CONFLICT_PENDING: "error.CONFLICT_PENDING",
  DISK_FULL: "error.DISK_FULL",
  IO_ERROR: "error.IO_ERROR",
  DB_ERROR: "error.DB_ERROR",
  HISTORY_UNAVAILABLE: "error.HISTORY_UNAVAILABLE",
  HISTORY_RESOURCE_MISSING: "error.HISTORY_RESOURCE_MISSING",
  HISTORY_STALE_DOCUMENT: "error.HISTORY_STALE_DOCUMENT",
  HISTORY_OPERATION_PENDING: "error.HISTORY_OPERATION_PENDING",
  HISTORY_BUSY: "error.HISTORY_BUSY",
  INTERNAL: "error.INTERNAL",
};

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODE_KEYS, code);
}

/** The IPC error code carried by an error, if any. */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * The single way to turn an error into user-facing text in the current UI
 * language. Internal messages (plain `Error`, backend `message`) are never
 * shown; `fallback` names what failed instead.
 */
export function describeError(
  error: unknown,
  fallback: MessageKey = "error.generic",
): string {
  if (error instanceof LocalizedError) return t(error.key, error.params);
  if (error instanceof DescribedError) return error.message;
  const code = errorCodeOf(error);
  if (code === undefined) return t(fallback);
  return isErrorCode(code)
    ? t(ERROR_CODE_KEYS[code])
    : t("error.unknown", { code });
}
