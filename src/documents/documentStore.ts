import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { getSceneVersion } from "@excalidraw/excalidraw";
import { createTauriCommandInvoker } from "../ipc/client";
import type {
  CheckpointReason,
  ExpectedOpenDocument,
  IpcEvents,
  PathMigration,
  SceneData,
} from "../ipc/contracts";
import {
  createEmptyScene,
  deserializeSceneData,
  serializeScene,
  type SceneSnapshot,
} from "../editor/sceneSerializer";
import { DraftScheduler } from "./draftScheduler";
import { createDocumentGateway, type DocumentGateway } from "./documentGateway";
import { bindActivateRunner, requestActivate } from "./tabActivationQueue";

export type DocumentSaveState =
  | "clean"
  | "dirty"
  | "savingDraft"
  | "draftSaved"
  | "checkpointing"
  | "conflicted"
  | "orphaned"
  | "error";

export interface ConflictInfo {
  externalMtime: number;
  localDraftUpdatedAt: number;
}

export interface DocumentSession {
  id: string;
  path: string;
  title: string;
  scene: SceneSnapshot;
  sceneVersion: number;
  revision: number;
  baseHash: string;
  saveState: DocumentSaveState;
  errorMessage: string | null;
  conflictInfo: ConflictInfo | null;
  lastReloadedAt: number | null;
}

export interface DocumentStoreState {
  sessionsById: Record<string, DocumentSession>;
  tabOrder: string[];
  activeDocumentId: string | null;
}

export type CloseOutcome =
  | { status: "closed" }
  | { status: "orphaned"; documentId: string }
  | { status: "failed"; documentId: string; message: string }
  | { status: "cancelled" }
  | { status: "inFlight" };

export class DocumentManager {
  readonly store: StoreApi<DocumentStoreState>;
  private readonly gateway: DocumentGateway;
  private readonly schedulers = new Map<
    string,
    DraftScheduler<SceneSnapshot>
  >();
  private readonly pathMutations = new Set<string>();
  private readonly closingById = new Map<string, Promise<CloseOutcome>>();
  private batchRemainder: string[] = [];

  constructor(gateway: DocumentGateway) {
    this.gateway = gateway;
    this.store = createStore<DocumentStoreState>(() => ({
      sessionsById: {},
      tabOrder: [],
      activeDocumentId: null,
    }));
    bindActivateRunner((documentId) => this.performActivate(documentId));
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

  async restore(path: string, sceneData: SceneData): Promise<string> {
    const scene = deserializeSceneData(sceneData);
    const existing = this.findByPath(path);
    let documentId: string;
    if (existing !== undefined) {
      await this.activate(existing.id);
      this.patchSession(existing.id, {
        scene,
        sceneVersion: getSceneVersion(scene.elements),
        revision: existing.revision + 1,
        saveState: "dirty",
        errorMessage: null,
      });
      documentId = existing.id;
    } else {
      const response = await this.gateway.open(path);
      documentId = await this.registerSession({
        path,
        scene,
        baseHash: response.baseHash,
        saveState: "dirty",
      });
    }
    this.schedulers.get(documentId)?.recordChange(scene);
    return documentId;
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
      revision: session.revision + 1,
      saveState: session.saveState === "orphaned" ? "orphaned" : "dirty",
      errorMessage: null,
      lastReloadedAt: null,
    });
    this.schedulers.get(documentId)?.recordChange(scene);
  }

  async activate(documentId: string): Promise<void> {
    await requestActivate(documentId);
  }

  private async performActivate(documentId: string): Promise<void> {
    const { activeDocumentId: activeId, sessionsById } = this.store.getState();
    if (activeId === documentId) {
      return;
    }

    if (sessionsById[documentId] === undefined) return;

    if (activeId !== null) {
      await this.schedulers.get(activeId)?.checkpoint("tabSwitch");
    }
    this.store.setState({ activeDocumentId: documentId });
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
    const activeId = this.store.getState().activeDocumentId;
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

  async close(documentId: string, discardDraft = false): Promise<CloseOutcome> {
    const inFlight = this.closingById.get(documentId);
    if (inFlight !== undefined) {
      return { status: "inFlight" };
    }
    const task = this.closeExclusive(documentId, discardDraft);
    this.closingById.set(documentId, task);
    try {
      return await task;
    } finally {
      this.closingById.delete(documentId);
    }
  }

  async closeMany(documentIds: readonly string[]): Promise<CloseOutcome> {
    const requested = new Set(documentIds);
    this.batchRemainder = this.store
      .getState()
      .tabOrder.filter((id) => requested.has(id));
    return this.continueBatch();
  }

  async confirmOrphanClose(
    documentId: string,
    decision: "saveAs" | "discard" | "cancel",
    saveAsPath?: string,
  ): Promise<CloseOutcome> {
    if (decision === "cancel") {
      this.batchRemainder = [];
      return { status: "cancelled" };
    }
    if (decision === "saveAs") {
      if (saveAsPath === undefined || saveAsPath.length === 0) {
        return {
          status: "failed",
          documentId,
          message: "A save location is required.",
        };
      }
      try {
        await this.saveOrphanedAs(documentId, saveAsPath);
      } catch (error) {
        return {
          status: "failed",
          documentId,
          message: getErrorMessage(error),
        };
      }
    }
    const outcome = await this.close(documentId, decision === "discard");
    if (outcome.status === "closed" && this.batchRemainder[0] === documentId) {
      this.batchRemainder.shift();
      const continued = await this.continueBatch();
      return continued.status === "closed" ? outcome : continued;
    }
    return outcome;
  }

  private async continueBatch(): Promise<CloseOutcome> {
    while (this.batchRemainder.length > 0) {
      const documentId = this.batchRemainder[0];
      if (documentId === undefined) {
        break;
      }
      const outcome = await this.close(documentId);
      if (outcome.status === "closed" || outcome.status === "inFlight") {
        this.batchRemainder.shift();
        continue;
      }
      return outcome;
    }
    return { status: "closed" };
  }

  private async closeExclusive(
    documentId: string,
    discardDraft: boolean,
  ): Promise<CloseOutcome> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return { status: "closed" };
    }

    if (session.saveState === "orphaned" && !discardDraft) {
      return { status: "orphaned", documentId };
    }

    try {
      if (!discardDraft) {
        await this.checkpoint(documentId, "tabClose");
      }
      await this.gateway.close(
        session.path,
        discardDraft ? "discardOrphan" : "checkpointed",
      );
    } catch (error) {
      return {
        status: "failed",
        documentId,
        message: getErrorMessage(error),
      };
    }

    this.dropSession(documentId);
    return { status: "closed" };
  }

  private dropSession(documentId: string): void {
    this.schedulers.get(documentId)?.dispose();
    this.schedulers.delete(documentId);
    this.store.setState((state) => {
      const sessionsById = { ...state.sessionsById };
      delete sessionsById[documentId];
      const closedIndex = state.tabOrder.indexOf(documentId);
      const tabOrder = state.tabOrder.filter((id) => id !== documentId);
      const fallbackIndex = Math.min(closedIndex, tabOrder.length - 1);
      return {
        sessionsById,
        tabOrder,
        activeDocumentId:
          state.activeDocumentId === documentId
            ? (tabOrder[fallbackIndex] ?? null)
            : state.activeDocumentId,
      };
    });
  }

  async coordinateEntryRename<
    Result extends { pathMigrations: PathMigration[] },
  >(
    workspaceRoot: string,
    sourceCanonicalPath: string,
    execute: (expectedOpenDocuments: ExpectedOpenDocument[]) => Promise<Result>,
  ): Promise<Result> {
    if (this.pathMutations.has(sourceCanonicalPath)) {
      throw new Error("A path mutation is already in progress.");
    }
    this.pathMutations.add(sourceCanonicalPath);
    try {
      const affected = Object.values(this.store.getState().sessionsById)
        .filter(
          (session) =>
            session.path === sourceCanonicalPath ||
            session.path.startsWith(`${sourceCanonicalPath}/`),
        )
        .map((session) => ({
          id: session.id,
          revision: session.revision,
          path: session.path,
        }));
      for (const session of affected) {
        await this.checkpoint(session.id, "manualSave");
      }
      const current = this.store.getState().sessionsById;
      const expectedOpenDocuments = affected.map((prepared) => {
        const session = current[prepared.id];
        if (
          session === undefined ||
          session.revision !== prepared.revision ||
          session.path !== prepared.path
        ) {
          throw new Error(
            `An Open Document changed during rename preparation (${prepared.id}: revision ${prepared.revision}->${session?.revision ?? "missing"}, path ${prepared.path}->${session?.path ?? "missing"}).`,
          );
        }
        return {
          relativePath: relativeDocumentPath(workspaceRoot, session.path),
          baseHash: session.baseHash,
        };
      });
      const result = await execute(expectedOpenDocuments);
      this.applyPathMigrations(result.pathMigrations);
      return result;
    } finally {
      this.pathMutations.delete(sourceCanonicalPath);
    }
  }

  entryDeleteBlock(canonicalPath: string): string | null {
    const session = this.findByPath(canonicalPath);
    if (session === undefined) return null;
    return session.saveState === "clean" ? null : session.id;
  }

  async coordinateCleanEntryDelete<Result>(
    workspaceRoot: string,
    canonicalPath: string,
    execute: (expectedOpenDocument?: ExpectedOpenDocument) => Promise<Result>,
  ): Promise<Result> {
    const session = this.findByPath(canonicalPath);
    if (session !== undefined && session.saveState !== "clean") {
      throw new Error(
        `Open Document ${session.id} must be clean before deletion.`,
      );
    }
    const result = await execute(
      session === undefined
        ? undefined
        : {
            relativePath: relativeDocumentPath(workspaceRoot, session.path),
            baseHash: session.baseHash,
          },
    );
    if (session !== undefined) this.disposeCommittedSession(session.id);
    return result;
  }

  setConflicted(documentId: string, conflicted: boolean): void {
    this.schedulers.get(documentId)?.setConflicted(conflicted);
    this.patchSession(documentId, {
      saveState: conflicted ? "conflicted" : "dirty",
    });
  }

  handleFileRenamed(path: string, newPath: string): void {
    const session = this.findByPath(path);
    if (session === undefined) {
      return;
    }
    const title = getFileName(newPath);
    if (session.saveState === "orphaned") {
      this.schedulers.get(session.id)?.setConflicted(false);
    }
    this.patchSession(session.id, {
      path: newPath,
      title,
      saveState: session.saveState === "orphaned" ? "dirty" : session.saveState,
    });
  }

  handleFileRemoved(path: string): void {
    const session = this.findByPath(path);
    if (session === undefined) {
      return;
    }
    this.schedulers.get(session.id)?.setConflicted(true);
    this.patchSession(session.id, { saveState: "orphaned" });
  }

  sessionByPath(path: string): DocumentSession | undefined {
    return this.findByPath(path);
  }

  updateConflictInfo(path: string, info: ConflictInfo): void {
    const session = this.findByPath(path);
    if (session === undefined) {
      return;
    }
    this.patchSession(session.id, { conflictInfo: info });
  }

  beginConflict(documentId: string, info: ConflictInfo): void {
    this.setConflicted(documentId, true);
    this.patchSession(documentId, { conflictInfo: info });
  }

  dismissConflict(documentId: string): void {
    this.patchSession(documentId, { conflictInfo: null });
  }

  async reloadFromDisk(documentId: string): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    const response = await this.gateway.open(session.path);
    const scene = deserializeSceneData(response.scene);
    this.schedulers.get(documentId)?.setConflicted(false);
    this.patchSession(documentId, {
      scene,
      sceneVersion: getSceneVersion(scene.elements),
      revision: session.revision + 1,
      baseHash: response.baseHash,
      saveState: "clean",
      conflictInfo: null,
      lastReloadedAt: Date.now(),
      errorMessage: null,
    });
  }

  async resolveConflict(
    documentId: string,
    resolution: "takeExternal" | "keepLocal" | "saveAsNew",
    saveAsPath?: string,
  ): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    const response = await this.gateway.resolveConflict(
      session.path,
      resolution,
      saveAsPath,
    );
    this.schedulers.get(documentId)?.setConflicted(false);

    if (resolution === "takeExternal" && response.scene !== undefined) {
      const scene = deserializeSceneData(response.scene);
      this.patchSession(documentId, {
        scene,
        sceneVersion: getSceneVersion(scene.elements),
        revision: session.revision + 1,
        baseHash: response.newBaseHash,
        saveState: "clean",
        conflictInfo: null,
        errorMessage: null,
      });
      return;
    }
    if (resolution === "keepLocal") {
      this.patchSession(documentId, {
        baseHash: response.newBaseHash,
        saveState: "dirty",
        conflictInfo: null,
        errorMessage: null,
      });
      return;
    }
    if (saveAsPath === undefined) {
      throw new Error("A destination is required to save the drawing as new.");
    }
    const title = getFileName(saveAsPath);
    this.patchSession(documentId, {
      path: saveAsPath,
      title,
      baseHash: response.newBaseHash,
      saveState: "clean",
      conflictInfo: null,
      errorMessage: null,
    });
  }

  async saveOrphanedAs(documentId: string, newPath: string): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    const response = await this.gateway.checkpoint(
      newPath,
      serializeScene(session.scene),
      "manualSave",
    );
    await this.gateway.close(session.path, "discardOrphan");
    this.schedulers.get(documentId)?.setConflicted(false);
    const title = getFileName(newPath);
    this.patchSession(documentId, {
      path: newPath,
      title,
      baseHash: response.newBaseHash,
      saveState: "clean",
      conflictInfo: null,
      errorMessage: null,
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
    const activeId = this.store.getState().activeDocumentId;
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
      revision: 0,
      baseHash,
      saveState,
      errorMessage: null,
      conflictInfo: null,
      lastReloadedAt: null,
    };

    const scheduler = new DraftScheduler<SceneSnapshot>({
      persistDraft: async (nextScene) => {
        this.patchSession(id, { saveState: "savingDraft" });
        const currentPath =
          this.store.getState().sessionsById[id]?.path ?? path;
        await this.gateway.saveDraft(currentPath, serializeScene(nextScene));
        if (this.store.getState().sessionsById[id]?.scene === nextScene) {
          this.patchSession(id, { saveState: "draftSaved" });
        }
      },
      checkpoint: async (nextScene, reason) => {
        this.patchSession(id, { saveState: "checkpointing" });
        const currentPath =
          this.store.getState().sessionsById[id]?.path ?? path;
        const response = await this.gateway.checkpoint(
          currentPath,
          serializeScene(nextScene),
          reason,
        );
        const current = this.store.getState().sessionsById[id];
        this.patchSession(id, {
          baseHash: response.newBaseHash,
          saveState: current?.scene === nextScene ? "clean" : "dirty",
          errorMessage: null,
        });
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
      tabOrder: [...state.tabOrder, id],
      activeDocumentId: id,
    }));
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

  private applyPathMigrations(migrations: readonly PathMigration[]): void {
    const byOldPath = new Map(
      migrations.map((migration) => [migration.oldCanonicalPath, migration]),
    );
    this.store.setState((state) => ({
      sessionsById: Object.fromEntries(
        Object.entries(state.sessionsById).map(([id, session]) => {
          const migration = byOldPath.get(session.path);
          return [
            id,
            migration === undefined
              ? session
              : {
                  ...session,
                  path: migration.newCanonicalPath,
                  title: getFileName(migration.newCanonicalPath),
                },
          ];
        }),
      ),
    }));
  }

  private disposeCommittedSession(documentId: string): void {
    this.schedulers.get(documentId)?.dispose();
    this.schedulers.delete(documentId);
    this.store.setState((state) => {
      const sessionsById = { ...state.sessionsById };
      delete sessionsById[documentId];
      const closedIndex = state.tabOrder.indexOf(documentId);
      const tabOrder = state.tabOrder.filter((id) => id !== documentId);
      return {
        sessionsById,
        tabOrder,
        activeDocumentId:
          state.activeDocumentId === documentId
            ? (tabOrder[Math.min(closedIndex, tabOrder.length - 1)] ?? null)
            : state.activeDocumentId,
      };
    });
  }
}

function relativeDocumentPath(
  workspaceRoot: string,
  canonicalPath: string,
): string {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const prefix = `${normalizedRoot}/`;
  if (!canonicalPath.startsWith(prefix)) {
    throw new Error("Open Document is outside the coordinated Workspace.");
  }
  return canonicalPath.slice(prefix.length);
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

type FileChangeEvent = { payload: IpcEvents["file-changed"] };
type FileChangeListener = (
  eventName: "file-changed",
  handler: (event: FileChangeEvent) => void,
) => Promise<() => void>;

export async function registerDocumentFileChangeEvents(
  manager: Pick<DocumentManager, "handleFileRemoved" | "handleFileRenamed">,
  listenForEvent: FileChangeListener = async (eventName, handler) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<IpcEvents["file-changed"]>(eventName, handler);
  },
): Promise<() => void> {
  return listenForEvent("file-changed", ({ payload }) => {
    if (payload.change === "renamed" && payload.newPath !== undefined) {
      manager.handleFileRenamed(payload.path, payload.newPath);
    } else if (payload.change === "removed") {
      manager.handleFileRemoved(payload.path);
    }
  });
}

export function useDocumentStore<Selection>(
  selector: (state: DocumentStoreState) => Selection,
): Selection {
  return useStore(documentManager.store, selector);
}
