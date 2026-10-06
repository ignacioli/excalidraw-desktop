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
import {
  deserializeSceneData,
  serializeScene,
} from "../editor/sceneSerializer";
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
  | "staleAutosavePrepared"
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
    const beforeReplacement = await createHistoryFrontendEvidence(
      request,
      documentId,
      editor.adapter.readScene(),
    );
    const staleAutosave =
      this.documents.prepareHistoryAutosaveProbe(documentId);
    if (staleAutosave === undefined) {
      throw new Error(
        "Could not capture the production document autosave callback before history replacement.",
      );
    }
    const staleAutosaveAttemptedHash = await hashScene(staleAutosave.scene);
    let staleAutosaveResultPromise:
      ReturnType<typeof staleAutosave.queue> | undefined;
    const instrumentedClient = {
      ...client,
      replace: (historyRequest: Parameters<typeof client.replace>[0]) => {
        const response = client.replace(historyRequest);
        staleAutosaveResultPromise ??= staleAutosave.queue();
        return response;
      },
    };
    const instrumentedCoordinator = new HistoryCoordinator(
      this.documents,
      instrumentedClient,
      async (scene, context) => {
        const adopted = await adoptSceneAssets(scene);
        if (this.attachedEditor?.documentId !== documentId) return false;
        await editor.adapter.replaceScene(adopted);
        return context.commit(adopted);
      },
    );
    await publishProgress("staleAutosavePrepared");
    await publishProgress("replacementStarted");
    const result = await instrumentedCoordinator.replace(
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
    if (staleAutosaveResultPromise === undefined) {
      throw new Error(
        "History replacement did not queue the stale autosave callback.",
      );
    }
    const staleAutosaveResult = await staleAutosaveResultPromise;
    const finalSession =
      this.documents.store.getState().sessionsById[documentId];
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
        staleAutosaveAttemptedHash,
        staleAutosaveCapturedSessionGeneration:
          staleAutosaveResult.captured.sessionGeneration,
        staleAutosaveCapturedRevision: staleAutosaveResult.captured.revision,
        staleAutosaveObservedSessionGeneration:
          staleAutosaveResult.observed?.sessionGeneration,
        staleAutosaveObservedRevision: staleAutosaveResult.observed?.revision,
        staleAutosaveRejected: staleAutosaveResult.status === "rejected",
        staleAutosaveRejection: staleAutosaveResult.rejection ?? null,
        staleAutosaveDraftSaveState: finalSession?.saveState ?? null,
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

async function hashScene(
  scene: Parameters<typeof serializeScene>[0],
): Promise<string> {
  const bytes = new TextEncoder().encode(serializeScene(scene));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function publishProgress(stage: FrontendProgressStage): Promise<void> {
  await invoke("e2e_history_frontend_publish", {
    evidence: { scenario: "history-frontend-progress", stage },
  });
}

export const nativeHistoryFrontendDriver = new NativeHistoryFrontendDriver(
  documentManager,
);
