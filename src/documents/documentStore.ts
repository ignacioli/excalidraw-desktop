import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { getSceneVersion } from "@excalidraw/excalidraw";
import { useAppStore } from "../app/store";
import { createTauriCommandInvoker } from "../ipc/client";
import type { CheckpointReason } from "../ipc/contracts";
import {
  createEmptyScene,
  deserializeSceneData,
  serializeScene,
  type SceneSnapshot,
} from "../editor/sceneSerializer";
import { DraftScheduler } from "./draftScheduler";
import { createDocumentGateway, type DocumentGateway } from "./documentGateway";

export type DocumentSaveState =
  | "clean"
  | "dirty"
  | "savingDraft"
  | "draftSaved"
  | "checkpointing"
  | "conflicted"
  | "error";

export interface DocumentSession {
  id: string;
  path: string;
  title: string;
  scene: SceneSnapshot;
  sceneVersion: number;
  baseHash: string;
  saveState: DocumentSaveState;
  errorMessage: string | null;
}

export interface DocumentStoreState {
  sessionsById: Record<string, DocumentSession>;
}

export class DocumentManager {
  readonly store: StoreApi<DocumentStoreState>;
  private readonly gateway: DocumentGateway;
  private readonly schedulers = new Map<
    string,
    DraftScheduler<SceneSnapshot>
  >();

  constructor(gateway: DocumentGateway) {
    this.gateway = gateway;
    this.store = createStore<DocumentStoreState>(() => ({ sessionsById: {} }));
  }

  async open(path: string): Promise<string> {
    const existing = this.findByPath(path);
    if (existing !== undefined) {
      await this.activate(existing.id);
      return existing.id;
    }

    const response = await this.gateway.open(path);
    const scene = deserializeSceneData(response.scene);
    return this.registerSession({
      path,
      scene,
      baseHash: response.baseHash,
      saveState: response.hasNewerDraft ? "draftSaved" : "clean",
    });
  }

  async create(path: string): Promise<string> {
    const scene = createEmptyScene();
    const sceneJson = serializeScene(scene);
    const response = await this.gateway.checkpoint(
      path,
      sceneJson,
      "manualSave",
    );
    return this.registerSession({
      path,
      scene,
      baseHash: response.newBaseHash,
      saveState: "clean",
    });
  }

  updateScene(documentId: string, scene: SceneSnapshot): void {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }

    const sceneVersion = getSceneVersion(scene.elements);
    if (!hasPersistedSceneChange(session, scene, sceneVersion)) {
      return;
    }

    this.patchSession(documentId, {
      scene,
      sceneVersion,
      saveState: "dirty",
      errorMessage: null,
    });
    useAppStore.getState().setDocumentDirty(documentId, true);
    this.schedulers.get(documentId)?.recordChange(scene);
  }

  async activate(documentId: string): Promise<void> {
    const activeId = useAppStore.getState().activeTabId;
    if (activeId === documentId) {
      return;
    }

    if (activeId !== null) {
      await this.schedulers.get(activeId)?.checkpoint("tabSwitch");
    }
    useAppStore.getState().setActiveTab(documentId);
  }

  async checkpoint(
    documentId: string,
    reason: CheckpointReason = "manualSave",
  ): Promise<void> {
    await this.schedulers.get(documentId)?.checkpoint(reason);
  }

  async checkpointActive(
    reason: CheckpointReason = "manualSave",
  ): Promise<void> {
    const activeId = useAppStore.getState().activeTabId;
    if (activeId !== null) {
      await this.checkpoint(activeId, reason);
    }
  }

  async checkpointAll(reason: CheckpointReason = "appExit"): Promise<void> {
    await Promise.all(
      [...this.schedulers.values()].map((scheduler) =>
        scheduler.checkpoint(reason),
      ),
    );
  }

  async close(documentId: string, discardDraft = false): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }

    if (!discardDraft) {
      await this.checkpoint(documentId, "tabClose");
    }
    await this.gateway.close(session.path, discardDraft);
    this.schedulers.get(documentId)?.dispose();
    this.schedulers.delete(documentId);
    this.store.setState((state) => {
      const sessionsById = { ...state.sessionsById };
      delete sessionsById[documentId];
      return { sessionsById };
    });
    useAppStore.getState().closeTab(documentId);
  }

  setConflicted(documentId: string, conflicted: boolean): void {
    this.schedulers.get(documentId)?.setConflicted(conflicted);
    this.patchSession(documentId, {
      saveState: conflicted ? "conflicted" : "dirty",
    });
  }

  dispose(): void {
    this.schedulers.forEach((scheduler) => scheduler.dispose());
    this.schedulers.clear();
  }

  private async registerSession({
    path,
    scene,
    baseHash,
    saveState,
  }: Pick<DocumentSession, "path" | "scene" | "baseHash" | "saveState">) {
    const activeId = useAppStore.getState().activeTabId;
    if (activeId !== null) {
      await this.schedulers.get(activeId)?.checkpoint("tabSwitch");
    }

    const id = createDocumentId();
    const title = getFileName(path);
    const session: DocumentSession = {
      id,
      path,
      title,
      scene,
      sceneVersion: getSceneVersion(scene.elements),
      baseHash,
      saveState,
      errorMessage: null,
    };

    const scheduler = new DraftScheduler<SceneSnapshot>({
      persistDraft: async (nextScene) => {
        this.patchSession(id, { saveState: "savingDraft" });
        await this.gateway.saveDraft(path, serializeScene(nextScene));
        if (this.store.getState().sessionsById[id]?.scene === nextScene) {
          this.patchSession(id, { saveState: "draftSaved" });
        }
      },
      checkpoint: async (nextScene, reason) => {
        this.patchSession(id, { saveState: "checkpointing" });
        const response = await this.gateway.checkpoint(
          path,
          serializeScene(nextScene),
          reason,
        );
        const current = this.store.getState().sessionsById[id];
        this.patchSession(id, {
          baseHash: response.newBaseHash,
          saveState: current?.scene === nextScene ? "clean" : "dirty",
          errorMessage: null,
        });
        if (current?.scene === nextScene) {
          useAppStore.getState().setDocumentDirty(id, false);
        }
      },
      onError: (error) => {
        this.patchSession(id, {
          saveState: "error",
          errorMessage: getErrorMessage(error),
        });
      },
    });

    this.schedulers.set(id, scheduler);
    this.store.setState((state) => ({
      sessionsById: { ...state.sessionsById, [id]: session },
    }));
    useAppStore.getState().registerTab({ id, path, title });
    return id;
  }

  private findByPath(path: string): DocumentSession | undefined {
    return Object.values(this.store.getState().sessionsById).find(
      (session) => session.path === path,
    );
  }

  private patchSession(
    documentId: string,
    patch: Partial<DocumentSession>,
  ): void {
    this.store.setState((state) => {
      const session = state.sessionsById[documentId];
      if (session === undefined) {
        return state;
      }
      return {
        sessionsById: {
          ...state.sessionsById,
          [documentId]: { ...session, ...patch },
        },
      };
    });
  }
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled";
}

function createDocumentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `document-${Date.now()}`;
}

function hasPersistedSceneChange(
  previous: DocumentSession,
  next: SceneSnapshot,
  nextSceneVersion: number,
): boolean {
  if (
    previous.sceneVersion !== nextSceneVersion ||
    !haveSameFiles(previous.scene.files, next.files)
  ) {
    return true;
  }

  const previousState = previous.scene.appState;
  const nextState = next.appState;
  return (
    previousState.name !== nextState.name ||
    previousState.viewBackgroundColor !== nextState.viewBackgroundColor ||
    previousState.gridModeEnabled !== nextState.gridModeEnabled ||
    previousState.gridSize !== nextState.gridSize ||
    previousState.gridStep !== nextState.gridStep
  );
}

function haveSameFiles(
  previous: SceneSnapshot["files"],
  next: SceneSnapshot["files"],
): boolean {
  if (previous === next) {
    return true;
  }
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  return (
    previousIds.length === nextIds.length &&
    previousIds.every((id) => previous[id] === next[id])
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The drawing could not be saved.";
}

export const documentManager = new DocumentManager(
  createDocumentGateway(createTauriCommandInvoker()),
);

export function useDocumentStore<Selection>(
  selector: (state: DocumentStoreState) => Selection,
): Selection {
  return useStore(documentManager.store, selector);
}
