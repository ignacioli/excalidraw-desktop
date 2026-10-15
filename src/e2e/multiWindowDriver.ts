import { invoke } from "@tauri-apps/api/core";

import { hasTauriCommandRuntime } from "../ipc/client";
import {
  documentManager,
  type DocumentManager,
} from "../documents/documentStore";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import { formatHistoryFrontendError } from "./historyFrontendError";

/**
 * Test-only driver for the multi-window process scenarios. The backend
 * queues requests per window label; this window takes its own, runs each
 * through the production document and Workspace paths, and answers with the
 * evidence. It runs only in an `e2e-harness` build started with
 * `EXCALIDRAW_E2E_MULTI_WINDOW=1`.
 */

export interface DriverRequest {
  id: string;
  action: string;
  args?: Record<string, unknown>;
}

export interface DriverControl {
  bootstrap(): Promise<boolean>;
  next(): Promise<DriverRequest | null>;
  publish(answer: {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): Promise<void>;
}

/** What the driver needs from the shell of its window. */
export interface DriverShell {
  /** Open a folder as this window's Workspace, as the folder dialog does. */
  openWorkspace(rootPath: string): Promise<void>;
}

export interface DriverEditor {
  isEditable(): boolean;
  applyPerformanceEdit(seed: number, editIndex: number): boolean;
}

export interface MultiWindowDriverDependencies {
  control: DriverControl;
  documents: Pick<DocumentManager, "store" | "openRouted" | "checkpoint">;
  root: ParentNode;
  wait(milliseconds: number): Promise<void>;
  timeoutMs?: number;
}

type ElementPosition = { id: string; x: number; y: number };

function positions(scene: SceneSnapshot): ElementPosition[] {
  return scene.elements
    .filter((element) => !element.isDeleted)
    .map((element) => ({ id: element.id, x: element.x, y: element.y }));
}

function text(element: Element): string {
  return (element.textContent ?? "").trim();
}

export class MultiWindowDriver {
  private shell: DriverShell | null = null;
  private readonly editors = new Map<string, DriverEditor>();
  private editCount = 0;
  private started = false;
  private stopped = false;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: MultiWindowDriverDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
  }

  attachShell(shell: DriverShell): void {
    this.shell = shell;
  }

  attachEditor(documentId: string, editor: DriverEditor): void {
    this.editors.set(documentId, editor);
  }

  /** Serve this window's requests until the window closes. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.serve().catch((error: unknown) => {
      console.error("Multi-window driver stopped.", error);
    });
  }

  /** Stop serving after the current request. */
  stop(): void {
    this.stopped = true;
  }

  private async serve(): Promise<void> {
    const { control, wait } = this.dependencies;
    if (!(await control.bootstrap())) return;
    while (!this.stopped) {
      const request = await control.next();
      if (request === null) {
        await wait(50);
        continue;
      }
      await control.publish(await this.answer(request));
    }
  }

  /** Run one request; a failure becomes the request's answer. */
  async answer(request: DriverRequest): Promise<{
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }> {
    try {
      return { id: request.id, ok: true, result: await this.run(request) };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        // IPC failures are `{ code, message }` objects, not Errors.
        error: formatHistoryFrontendError(error),
      };
    }
  }

  private async run(request: DriverRequest): Promise<unknown> {
    const args = request.args ?? {};
    const path = typeof args.path === "string" ? args.path : null;
    switch (request.action) {
      case "openWorkspace": {
        if (typeof args.rootPath !== "string")
          throw new Error("openWorkspace needs a rootPath.");
        if (this.shell === null) throw new Error("The shell is not ready.");
        await this.shell.openWorkspace(args.rootPath);
        return {};
      }
      case "openDrawing": {
        if (path === null) throw new Error("openDrawing needs a path.");
        return {
          documentId: await this.dependencies.documents.openRouted(path),
        };
      }
      case "edit": {
        if (path === null) throw new Error("edit needs a path.");
        return await this.edit(path, Number(args.seed ?? 1));
      }
      case "save": {
        if (path === null) throw new Error("save needs a path.");
        return await this.save(path);
      }
      case "paste": {
        if (path === null || typeof args.clipboardText !== "string")
          throw new Error("paste needs a path and clipboardText.");
        return await this.paste(path, args.clipboardText);
      }
      case "report":
        return this.report();
      case "recover":
        return await this.recover();
      default:
        throw new Error(`Unknown window request ${request.action}.`);
    }
  }

  /**
   * Move one element of the drawing's canvas and wait until the draft of
   * that edit is stored, so the edit survives a killed process.
   */
  private async edit(path: string, seed: number) {
    const { documents } = this.dependencies;
    const documentId = await documents.openRouted(path);
    if (documentId === null)
      throw new Error("The drawing is open in another window.");
    const editor = await this.until(() => {
      const candidate = this.editors.get(documentId);
      return candidate?.isEditable() === true ? candidate : undefined;
    }, "the editor of the drawing");
    const before = documents.store.getState().sessionsById[documentId];
    if (before === undefined) throw new Error("The drawing has no session.");
    if (!editor.applyPerformanceEdit(seed, this.editCount))
      throw new Error("The drawing has no element to move.");
    this.editCount += 1;
    const session = await this.until(() => {
      const current = documents.store.getState().sessionsById[documentId];
      return current !== undefined &&
        current.revision > before.revision &&
        current.saveState === "draftSaved"
        ? current
        : undefined;
    }, "the draft of the edit");
    return { documentId, elements: positions(session.scene) };
  }

  /** Save the drawing as File > Save does and answer once it is clean. */
  private async save(path: string) {
    const { documents } = this.dependencies;
    const documentId = await documents.openRouted(path);
    if (documentId === null)
      throw new Error("The drawing is open in another window.");
    await documents.checkpoint(documentId, "manualSave");
    const session = documents.store.getState().sessionsById[documentId];
    if (session === undefined) throw new Error("The drawing has no session.");
    return {
      documentId,
      saveState: session.saveState,
      elements: positions(session.scene),
    };
  }

  /**
   * Paste `clipboardText` as the SDK receives a keyboard paste (a pointer
   * move over the canvas, then a document `paste` event) and wait until the
   * draft of the paste is stored.
   */
  private async paste(path: string, clipboardText: string) {
    const { documents, root } = this.dependencies;
    const documentId = await documents.openRouted(path);
    if (documentId === null)
      throw new Error("The drawing is open in another window.");
    await this.until(
      () =>
        this.editors.get(documentId)?.isEditable() === true ? true : undefined,
      "the editor of the drawing",
    );
    const canvas = root.querySelector<HTMLCanvasElement>(
      `.excalidraw-editor[data-document-id="${documentId}"] .excalidraw__canvas.interactive`,
    );
    if (canvas === null) throw new Error("The drawing has no canvas.");
    const before = documents.store.getState().sessionsById[documentId];
    if (before === undefined) throw new Error("The drawing has no session.");
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      }),
    );
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", clipboardText);
    canvas.ownerDocument.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    const session = await this.until(() => {
      const current = documents.store.getState().sessionsById[documentId];
      return current !== undefined &&
        current.revision > before.revision &&
        current.saveState === "draftSaved"
        ? current
        : undefined;
    }, "the draft of the paste");
    return { documentId, elements: positions(session.scene) };
  }

  /** This window's tabs, active tab, Welcome, Recovery dialog, and errors. */
  private report() {
    const state = this.dependencies.documents.store.getState();
    const tabs = state.tabOrder.flatMap((id) => {
      const session = state.sessionsById[id];
      return session === undefined
        ? []
        : [
            {
              path: session.path,
              saveState: session.saveState,
              elements: positions(session.scene),
            },
          ];
    });
    const active =
      state.activeDocumentId === null
        ? null
        : (state.sessionsById[state.activeDocumentId]?.path ?? null);
    const root = this.dependencies.root;
    return {
      tabs,
      activePath: active,
      welcome: root.querySelector('[data-testid="welcome-screen"]') !== null,
      recoveryCandidates: Array.from(
        root.querySelectorAll(".recovery-candidate .recovery-candidate-path"),
        text,
      ),
      alerts: this.errors(),
    };
  }

  /** Error messages on screen: alerts and the shell's save status error. */
  private errors(): string[] {
    return Array.from(
      this.dependencies.root.querySelectorAll(
        '[role="alert"], .save-status--error',
      ),
      text,
    ).filter((message) => message.length > 0);
  }

  /** Restore every Recovery candidate through the dialog's own buttons. */
  private async recover() {
    const root = this.dependencies.root;
    const restored: string[] = [];
    for (;;) {
      const candidate = root.querySelector(".recovery-candidate");
      if (candidate === null) break;
      const path = text(
        candidate.querySelector(".recovery-candidate-path") ?? candidate,
      );
      const restore = candidate.querySelector<HTMLButtonElement>(
        ".recovery-candidate-actions button",
      );
      if (restore === null) throw new Error("A candidate has no Restore.");
      await this.until(
        () => (restore.disabled ? undefined : true),
        "an enabled Restore",
      );
      restore.click();
      await this.until(
        () => (root.contains(candidate) ? undefined : true),
        `the Recovery of ${path}`,
      ).catch((error: unknown) => {
        const shown = this.errors();
        throw shown.length === 0
          ? error
          : new Error(`${String(error)} Shown: ${shown.join(" | ")}`);
      });
      restored.push(path);
    }
    return { restored };
  }

  private async until<T>(read: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${what}.`);
      await this.dependencies.wait(25);
    }
  }
}

const tauriControl: DriverControl = {
  bootstrap: async () =>
    hasTauriCommandRuntime() &&
    (await invoke<boolean>("e2e_multi_window_bootstrap")),
  next: () => invoke<DriverRequest | null>("e2e_multi_window_next"),
  publish: async (answer) => {
    await invoke("e2e_multi_window_publish", {
      id: answer.id,
      ok: answer.ok,
      result: answer.result ?? null,
      error: answer.error ?? null,
    });
  },
};

export const multiWindowDriver = new MultiWindowDriver({
  control: tauriControl,
  documents: documentManager,
  root: document,
  wait: (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
});
