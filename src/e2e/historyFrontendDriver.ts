import { invoke } from "@tauri-apps/api/core";

import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
} from "../ipc/client";
import { adoptSceneAssets } from "../history/assetAdoption";
import { HistoryCoordinator } from "../history/historyCoordinator";
import { createHistoryClient } from "../history/historyClient";
import {
  documentManager,
  type DocumentManager,
} from "../documents/documentStore";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import type { SceneSnapshot } from "../editor/sceneSerializer";

interface DriverRequest {
  documentPath: string;
  targetVersionId: string;
  requestId: string;
}

interface FrontendEvidence {
  scenario: "history-frontend-adoption";
  requestId: string;
  targetVersionId: string;
  documentId: string;
  adopted: true;
  canvasReadback: {
    elementIds: string[];
    elementTypes: string[];
    appState: Record<string, unknown>;
    assetHashes: Record<string, string>;
  };
}

interface AttachedEditor {
  documentId: string;
  adapter: ExcalidrawAdapter;
}

export class NativeHistoryFrontendDriver {
  private attachedEditor: AttachedEditor | null = null;
  private started = false;

  constructor(private readonly documents: DocumentManager) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!hasTauriCommandRuntime()) {
      console.error("Native history frontend driver has no Tauri runtime.");
      return;
    }
    void this.run().catch((error: unknown) => {
      console.error("Native history frontend driver failed.", error);
      void invoke("e2e_history_frontend_publish", {
        evidence: {
          scenario: "history-frontend-error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }

  attachEditor(documentId: string, adapter: ExcalidrawAdapter): void {
    this.attachedEditor = { documentId, adapter };
  }

  private async run(): Promise<void> {
    const request = await invoke<DriverRequest | null>(
      "e2e_history_frontend_bootstrap",
      {},
    );
    if (request === null) return;

    const documentId = await this.documents.open(request.documentPath);
    const editor = await this.waitForEditor(documentId);
    const coordinator = new HistoryCoordinator(
      this.documents,
      createHistoryClient(createTauriCommandInvoker()),
      async (scene, context) => {
        const adopted = await adoptSceneAssets(scene);
        if (this.attachedEditor?.documentId !== documentId) return false;
        await editor.adapter.replaceScene(adopted);
        return context.commit(adopted);
      },
    );
    const result = await coordinator.replace(
      documentId,
      { kind: "restore", versionId: request.targetVersionId },
      request.requestId,
    );
    if (!result.adopted) {
      throw new Error(
        "History replacement did not commit to the active canvas.",
      );
    }
    const readback = editor.adapter.readScene();
    await invoke("e2e_history_frontend_publish", {
      evidence: await createEvidence(request, documentId, readback),
    });
  }

  private async waitForEditor(documentId: string): Promise<AttachedEditor> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const editor = this.attachedEditor;
      if (editor?.documentId === documentId && editor.adapter.isEditable()) {
        return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the native Excalidraw editor.");
  }
}

async function createEvidence(
  request: DriverRequest,
  documentId: string,
  scene: SceneSnapshot,
): Promise<FrontendEvidence> {
  const assetHashes: Record<string, string> = {};
  for (const [fileId, file] of Object.entries(scene.files)) {
    if (!file.dataURL.startsWith("data:")) continue;
    const bytes = decodeDataUrl(file.dataURL);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    assetHashes[fileId] = bytesToHex(new Uint8Array(digest));
  }
  return {
    scenario: "history-frontend-adoption",
    requestId: request.requestId,
    targetVersionId: request.targetVersionId,
    documentId,
    adopted: true,
    canvasReadback: {
      elementIds: scene.elements.map((element) => element.id),
      elementTypes: scene.elements.map((element) => element.type),
      appState: {
        viewBackgroundColor: scene.appState.viewBackgroundColor,
      },
      assetHashes,
    },
  };
}

function decodeDataUrl(dataUrl: string): ArrayBuffer {
  const payload = dataUrl.split(",", 2)[1];
  if (payload === undefined)
    throw new Error("Canvas asset data URL is malformed.");
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export const nativeHistoryFrontendDriver = new NativeHistoryFrontendDriver(
  documentManager,
);
