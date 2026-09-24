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
import { deserializeSceneData } from "../editor/sceneSerializer";
import { createHistoryFrontendEvidence } from "./historyFrontendEvidence";
import { formatHistoryFrontendError } from "./historyFrontendError";

interface DriverRequest {
  documentPath: string;
  targetVersionId: string;
  requestId: string;
}

interface AttachedEditor {
  documentId: string;
  adapter: ExcalidrawAdapter;
}

type FrontendProgressStage =
  | "startupPathReceived"
  | "sessionOpened"
  | "editorAttached"
  | "replacementStarted"
  | "replacementCompleted"
  | "canvasReadbackReady";

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
          error: formatHistoryFrontendError(error),
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
    await publishProgress("startupPathReceived");

    const documentId = await this.waitForDocument(request.documentPath);
    await publishProgress("sessionOpened");
    const editor = await this.waitForEditor(documentId);
    await publishProgress("editorAttached");
    const client = createHistoryClient(createTauriCommandInvoker());
    const document = { kind: "path" as const, path: request.documentPath };
    const listing = await client.list({ document });
    if (
      !listing.items.some((item) => item.versionId === request.targetVersionId)
    ) {
      throw new Error(
        "Requested history version is absent from the reopened history list.",
      );
    }
    const preview = await client.preview({
      document,
      versionId: request.targetVersionId,
    });
    if (preview.versionId !== request.targetVersionId)
      throw new Error("History preview version does not match the request.");
    const previewEvidence = await createHistoryFrontendEvidence(
      request,
      documentId,
      await adoptSceneAssets(deserializeSceneData(preview.scene)),
    );
    const coordinator = new HistoryCoordinator(
      this.documents,
      client,
      async (scene, context) => {
        const adopted = await adoptSceneAssets(scene);
        if (this.attachedEditor?.documentId !== documentId) return false;
        await editor.adapter.replaceScene(adopted);
        return context.commit(adopted);
      },
    );
    const beforeReplacement = await createHistoryFrontendEvidence(
      request,
      documentId,
      editor.adapter.readScene(),
    );
    await publishProgress("replacementStarted");
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
    await publishProgress("replacementCompleted");
    const readback = editor.adapter.readScene();
    const evidence = await createHistoryFrontendEvidence(
      request,
      documentId,
      readback,
    );
    await publishProgress("canvasReadbackReady");
    await invoke("e2e_history_frontend_publish", {
      evidence: {
        ...evidence,
        beforeReplacement: beforeReplacement.canvasReadback,
        listedVersionIds: listing.items.map((item) => item.versionId),
        previewVersionId: preview.versionId,
        previewReadback: previewEvidence.canvasReadback,
      },
    });
    await invoke("e2e_history_frontend_close", {});
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

  private async waitForDocument(path: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const session = Object.values(
        this.documents.store.getState().sessionsById,
      ).find((candidate) => candidate.path === path);
      if (session !== undefined) return session.id;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error(
      "Timed out waiting for the authorized startup document session.",
    );
  }
}

async function publishProgress(stage: FrontendProgressStage): Promise<void> {
  await invoke("e2e_history_frontend_publish", {
    evidence: { scenario: "history-frontend-progress", stage },
  });
}

export const nativeHistoryFrontendDriver = new NativeHistoryFrontendDriver(
  documentManager,
);
