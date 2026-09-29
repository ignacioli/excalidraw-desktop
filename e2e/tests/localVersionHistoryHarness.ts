import type { Page } from "@playwright/test";

export interface HistoryHarnessInvocation {
  command: string;
  args: Record<string, unknown>;
}

export interface HistoryHarnessState {
  invocations: HistoryHarnessInvocation[];
  writeCommands: string[];
}

interface SeedVersion {
  versionId: string;
  source: "automatic" | "manual" | "protected";
  protectedAction?: "restore" | "clear" | "import";
  recordedAt: number;
  sequence: number;
  contentHash: string;
  availability:
    | { status: "available" }
    | {
        status: "unavailable";
        error: {
          code: "HISTORY_RESOURCE_MISSING";
          message: string;
          retriable: boolean;
        };
      };
}

const VERSIONS: SeedVersion[] = Array.from({ length: 100 }, (_, index) => {
  const id = `v-${String(index).padStart(3, "0")}`;
  if (index === 2) {
    return {
      versionId: id,
      source: "protected",
      protectedAction: "restore",
      recordedAt: Date.UTC(2025, 0, 3, 12, 0) / 1_000,
      sequence: index,
      contentHash: hashFor(index),
      availability: { status: "available" },
    };
  }
  if (index === 7) {
    return {
      versionId: id,
      source: "automatic",
      recordedAt: Date.UTC(2025, 0, 8, 12, 0) / 1_000,
      sequence: index,
      contentHash: hashFor(index),
      availability: {
        status: "unavailable",
        error: {
          code: "HISTORY_RESOURCE_MISSING",
          message: "The saved version resource is missing.",
          retriable: false,
        },
      },
    };
  }
  return {
    versionId: id,
    source: index === 1 ? "manual" : "automatic",
    recordedAt: Date.UTC(2025, 0, 1 + index, 12, 0) / 1_000,
    sequence: index,
    contentHash: hashFor(index),
    availability: { status: "available" },
  };
});

function hashFor(index: number): string {
  return `${String(index).padStart(3, "0")}${"0".repeat(61)}`;
}

export async function installLocalVersionHistoryHarness(
  page: Page,
): Promise<void> {
  await page.addInitScript((versions) => {
    type InvokeArgs = Record<string, unknown>;
    type EventCallback = (event: {
      event: string;
      id: number;
      payload: unknown;
    }) => void;
    type BrowserWindow = Window & {
      __EXCALIDRAW_HISTORY_E2E__?: boolean;
      __TAURI_INTERNALS__?: {
        invoke(command: string, args?: InvokeArgs): Promise<unknown>;
      };
      __historyHarness?: {
        invocations: { command: string; args: InvokeArgs }[];
        writeCommands: string[];
      };
    };

    const browser = globalThis as BrowserWindow;
    browser.__EXCALIDRAW_HISTORY_E2E__ = true;
    const state = {
      invocations: [] as { command: string; args: InvokeArgs }[],
      writeCommands: [] as string[],
    };
    browser.__historyHarness = state;

    const callbacks = new Map<number, EventCallback>();
    let nextCallbackId = 1;
    browser.__TAURI_INTERNALS__ = {
      async invoke(command, args = {}) {
        state.invocations.push({ command, args: { ...args } });
        if (
          command === "history_replace" ||
          command === "history_mark" ||
          command === "history_delete" ||
          command === "doc_save_draft" ||
          command === "doc_checkpoint"
        ) {
          state.writeCommands.push(command);
        }
        if (command === "plugin:event|listen") {
          const callbackId = Number(args.handler ?? nextCallbackId++);
          callbacks.set(callbackId, () => undefined);
          return callbackId;
        }
        if (command === "plugin:event|unlisten") {
          callbacks.delete(Number(args.eventId));
          return {};
        }
        if (command === "history_list") {
          const request = args.request as InvokeArgs | undefined;
          if (request === undefined)
            throw new Error("Missing history request envelope");
          const limit = Number(request.limit ?? 50);
          const cursor =
            typeof request.cursor === "string" ? request.cursor : null;
          const start =
            cursor === null ? 0 : Number(cursor.replace("cursor-", ""));
          const page = versions.slice(start, start + limit);
          const nextStart = start + page.length;
          return {
            documentId: String(
              (request.document as { path?: unknown } | undefined)?.path ?? "",
            ),
            items: page,
            nextCursor:
              nextStart < versions.length ? `cursor-${nextStart}` : undefined,
            listRevision: 1,
          };
        }
        if (command === "history_preview") {
          const request = args.request as InvokeArgs | undefined;
          if (request === undefined)
            throw new Error("Missing history request envelope");
          const versionId = String(request.versionId ?? "");
          if (versionId === "v-003") {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          return {
            versionId,
            scene: {
              type: "excalidraw",
              version: 2,
              source: "local-version-history-browser-fixture",
              elements: [{ id: `${versionId}-element`, type: "text" }],
              appState: {},
              files: {},
            },
          };
        }
        throw new Error(`Unexpected local history harness command: ${command}`);
      },
    };
  }, VERSIONS);
}

export async function readLocalVersionHistoryHarnessState(
  page: Page,
): Promise<HistoryHarnessState> {
  return page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __historyHarness?: HistoryHarnessState;
      }
    ).__historyHarness;
    return {
      invocations: state?.invocations ?? [],
      writeCommands: state?.writeCommands ?? [],
    };
  });
}
