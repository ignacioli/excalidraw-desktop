import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorCode } from "../ipc/contracts";
import { DescribedError, describeError, LocalizedError } from "./describeError";
import { initializeBrowserLocaleController, translate } from "./index";
import { en } from "./messages/en.ts";
import { zhCN } from "./messages/zh-CN.ts";

const ERROR_CODES: readonly ErrorCode[] = [
  "PATH_ACCESS_DENIED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_MOUNTED",
  "WORKSPACE_OVERLAP",
  "INVALID_NAME",
  "NAME_CONFLICT",
  "ENTRY_PROTECTED",
  "DIRECTORY_NOT_EMPTY",
  "ENTRY_CHANGED",
  "FILE_NOT_FOUND",
  "FILE_CORRUPTED",
  "FILE_TOO_LARGE",
  "INVALID_SCENE",
  "CONFLICT_PENDING",
  "DISK_FULL",
  "IO_ERROR",
  "DB_ERROR",
  "HISTORY_UNAVAILABLE",
  "HISTORY_RESOURCE_MISSING",
  "HISTORY_STALE_DOCUMENT",
  "HISTORY_OPERATION_PENDING",
  "HISTORY_BUSY",
  "INTERNAL",
];

const locale = initializeBrowserLocaleController(["en-US"]);
afterEach(() => act(() => locale.setPreference("en")));

function ipcError(code: string) {
  return { code, message: "internal backend detail", retriable: false };
}

describe("describeError", () => {
  it("has distinct English and Simplified Chinese copy for all 23 error codes", () => {
    expect(ERROR_CODES).toHaveLength(23);
    for (const code of ERROR_CODES) {
      const key = `error.${code}` as const;
      expect(en[key], key).toBeTruthy();
      expect(zhCN[key], key).toBeTruthy();
      expect(zhCN[key], key).not.toBe(en[key]);
    }
  });

  it("describes IPC errors by code in the current language", () => {
    act(() => locale.setPreference("en"));
    expect(describeError(ipcError("DISK_FULL"))).toBe(en["error.DISK_FULL"]);
    act(() => locale.setPreference("zh-CN"));
    expect(describeError(ipcError("DISK_FULL"))).toBe(zhCN["error.DISK_FULL"]);
  });

  it("names the code of an unknown IPC error", () => {
    act(() => locale.setPreference("zh-CN"));
    expect(describeError(ipcError("SOMETHING_NEW"))).toBe(
      translate("zh-CN", "error.unknown", { code: "SOMETHING_NEW" }),
    );
  });

  it("translates frontend errors that carry a message key", () => {
    const error = new LocalizedError("error.importMultipleDrawings");
    act(() => locale.setPreference("en"));
    expect(describeError(error)).toBe(en["error.importMultipleDrawings"]);
    act(() => locale.setPreference("zh-CN"));
    expect(describeError(error)).toBe(zhCN["error.importMultipleDrawings"]);
  });

  it("never shows a plain Error's internal message", () => {
    const internal = new Error("Document doc-1 is not open.");
    expect(describeError(internal)).toBe(en["error.generic"]);
    expect(describeError(internal, "error.saveFailed")).toBe(
      en["error.saveFailed"],
    );
    expect(describeError("raw string")).toBe(en["error.generic"]);
    expect(describeError({ message: "backend text" })).toBe(
      en["error.generic"],
    );
  });

  it("passes through text that was already described", () => {
    expect(describeError(new DescribedError("已本地化的文本"))).toBe(
      "已本地化的文本",
    );
  });
});
