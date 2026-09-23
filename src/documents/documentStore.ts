import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { getSceneVersion } from "@excalidraw/excalidraw";
import { createTauriCommandInvoker } from "../ipc/client";
import type {
  CheckpointReason,
  ExpectedOpenDocument,
  HistoryIssueEvent,
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
import { DocumentOperationQueue, DraftScheduler } from "./draftScheduler";
import { createDocumentGateway, type DocumentGateway } from "./documentGateway";
import { bindActivateRunner, requestActivate } from "./tabActivationQueue";
import { defaultEventListener, type EventListener } from "../ipc/events";

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
  /** Persistent history identity, when the backend has resolved one. */
  historyDocumentId?: string;
  path: string;
  title: string;
  scene: SceneSnapshot;
  sceneVersion: number;
  /** Invalidates work captured before a document replacement/rebase. */
  sessionGeneration?: number;
  revision: number;
  baseHash: string;
  saveState: DocumentSaveState;
  errorMessage: string | null;
  conflictInfo: ConflictInfo | null;
  historyIssue?: HistoryIssueEvent | null;
  lastReloadedAt: number | null;
}

export interface DocumentSessionVersion {
  sessionGeneration: number;
  revision: number;
}

export interface DocumentOperationContext extends DocumentSessionVersion {
  documentId: string;
  path: string;
  baseHash: string;
  isCurrent: () => boolean;
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
  private readonly operationQueues = new Map<string, DocumentOperationQueue>();
  private readonly pathMutations = new Set<string>();
  private readonly closingById = new Map<string, Promise<CloseOutcome>>();
  private readonly historyFrozen = new Set<string>();
  private readonly historyPending = new Map<string, string>();
  private readonly historyCheckpointPreparing = new Set<string>();
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

  async createUntitled(): Promise<string> {
    return this.registerSession({
      path: "",
      scene: createEmptyScene(),
      baseHash: "",
      saveState: "dirty",
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
        sessionGeneration: (existing.sessionGeneration ?? 0) + 1,
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
    if (this.historyFrozen.has(documentId)) {
      return;
    }
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
    if (
      this.historyFrozen.has(documentId) &&
      !this.historyCheckpointPreparing.has(documentId)
    ) {
      throw new Error("A protected history operation is still pending.");
    }
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
    const frozenHistory = [...this.historyFrozen];
    if (frozenHistory.length > 0) {
      throw new Error(
        `A protected history operation is still in progress for ${frozenHistory.length} document${frozenHistory.length === 1 ? "" : "s"}.`,
      );
    }
    await Promise.all(
      [...this.schedulers.values()].map((scheduler) =>
        scheduler.checkpoint(reason),
      ),
    );
  }

  /**
   * Runs a document-scoped operation after previously queued draft/checkpoint
   * writes. History replacement and reconciliation use this seam; callers
   * must use the supplied version to reject stale responses before adoption.
   */
  runDocumentOperation<Result>(
    documentId: string,
    operation: (context: DocumentOperationContext) => Promise<Result> | Result,
  ): Promise<Result> {
    const queue = this.operationQueues.get(documentId);
    if (queue === undefined) {
      return Promise.reject(new Error(`Document ${documentId} is not open.`));
    }
    return queue.enqueue(async () => {
      const session = this.store.getState().sessionsById[documentId];
      if (session === undefined) {
        throw new Error(`Document ${documentId} is not open.`);
      }
      const version = {
        sessionGeneration: session.sessionGeneration ?? 0,
        revision: session.revision,
      };
      return operation({
        ...version,
        documentId,
        path: session.path,
        baseHash: session.baseHash,
        isCurrent: () => this.isDocumentVersionCurrent(documentId, version),
      });
    });
  }

  /**
   * Freeze destructive scene updates while a protected history operation is
   * in flight. The normal scheduler and this operation share one queue, so a
   * checkpoint already queued before the freeze drains before the request.
   */
  async runHistoryReplacement<Result>(
    documentId: string,
    operation: (context: DocumentOperationContext) => Promise<Result> | Result,
  ): Promise<Result> {
    if (this.historyFrozen.has(documentId)) {
      throw new Error("A protected history operation is already in progress.");
    }
    if (this.store.getState().sessionsById[documentId] === undefined) {
      throw new Error(`Document ${documentId} is not open.`);
    }
    this.historyFrozen.add(documentId);
    try {
      this.historyCheckpointPreparing.add(documentId);
      await this.schedulers.get(documentId)?.checkpoint("manualSave");
      this.historyCheckpointPreparing.delete(documentId);
      return await this.runDocumentOperation(documentId, operation);
    } finally {
      this.historyCheckpointPreparing.delete(documentId);
      if (!this.historyPending.has(documentId)) {
        this.historyFrozen.delete(documentId);
      }
    }
  }

  /** Query a pending history operation while keeping stale scene writes frozen. */
  async runHistoryStatus<Result>(
    documentId: string,
    operation: (context: DocumentOperationContext) => Promise<Result> | Result,
    requestId?: string,
  ): Promise<Result> {
    if (
      this.historyFrozen.has(documentId) &&
      this.historyPending.get(documentId) !== requestId
    ) {
      throw new Error("A protected history operation is already in progress.");
    }
    if (this.store.getState().sessionsById[documentId] === undefined) {
      throw new Error(`Document ${documentId} is not open.`);
    }
    this.historyFrozen.add(documentId);
    try {
      return await this.runDocumentOperation(documentId, operation);
    } finally {
      if (!this.historyPending.has(documentId)) {
        this.historyFrozen.delete(documentId);
      }
    }
  }

  retainHistoryPending(documentId: string, requestId: string): void {
    this.historyPending.set(documentId, requestId);
    this.historyFrozen.add(documentId);
  }

  releaseHistoryPending(documentId: string, requestId: string): void {
    if (this.historyPending.get(documentId) !== requestId) {
      return;
    }
    this.historyPending.delete(documentId);
    this.historyFrozen.delete(documentId);
  }

  isHistoryFrozen(documentId: string): boolean {
    return this.historyFrozen.has(documentId);
  }

  /** Apply one backend-verified scene only if the captured session is current. */
  adoptHistoryScene(
    documentId: string,
    version: DocumentSessionVersion,
    scene: SceneSnapshot,
    newBaseHash: string,
    newSessionGeneration: number,
  ): boolean {
    if (!this.isDocumentVersionCurrent(documentId, version)) {
      return false;
    }
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return false;
    }
    this.schedulers.get(documentId)?.setConflicted(false);
    this.patchSession(documentId, {
      scene,
      sceneVersion: getSceneVersion(scene.elements),
      sessionGeneration: newSessionGeneration,
      revision: session.revision + 1,
      baseHash: newBaseHash,
      saveState: "clean",
      conflictInfo: null,
      errorMessage: null,
    });
    return true;
  }

  getDocumentVersion(documentId: string): DocumentSessionVersion | undefined {
    const session = this.store.getState().sessionsById[documentId];
    return session === undefined
      ? undefined
      : {
          sessionGeneration: session.sessionGeneration ?? 0,
          revision: session.revision,
        };
  }

  isDocumentVersionCurrent(
    documentId: string,
    version: DocumentSessionVersion,
  ): boolean {
    const current = this.getDocumentVersion(documentId);
    return (
      current !== undefined &&
      current.sessionGeneration === version.sessionGeneration &&
      current.revision === version.revision
    );
  }

  advanceSessionGeneration(
    documentId: string,
  ): DocumentSessionVersion | undefined {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return undefined;
    }
    const version = {
      sessionGeneration: (session.sessionGeneration ?? 0) + 1,
      revision: session.revision,
    };
    this.patchSession(documentId, {
      sessionGeneration: version.sessionGeneration,
    });
    return version;
  }

  bindHistoryDocumentId(
    documentId: string,
    historyDocumentId: string,
  ): boolean {
    if (this.store.getState().sessionsById[documentId] === undefined) {
      return false;
    }
    this.patchSession(documentId, { historyDocumentId });
    return true;
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

  async closeWorkspaceDocuments(workspaceRoot: string): Promise<CloseOutcome> {
    const { sessionsById, tabOrder } = this.store.getState();
    const documentIds = tabOrder.filter((documentId) => {
      const path = sessionsById[documentId]?.path;
      return path !== undefined && isPathWithinRoot(path, workspaceRoot);
    });
    return this.closeMany(documentIds);
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
    if (this.historyFrozen.has(documentId)) {
      return { status: "inFlight" };
    }

    if (session.saveState === "orphaned" && !discardDraft) {
      return { status: "orphaned", documentId };
    }

    try {
      if (session.path.length > 0) {
        if (!discardDraft) {
          await this.checkpoint(documentId, "tabClose");
        }
        await this.runDocumentOperation(documentId, async () => {
          const currentPath =
            this.store.getState().sessionsById[documentId]?.path ??
            session.path;
          await this.gateway.close(
            currentPath,
            discardDraft ? "discardOrphan" : "checkpointed",
          );
        });
      }
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
    this.historyFrozen.delete(documentId);
    this.historyPending.delete(documentId);
    this.historyCheckpointPreparing.delete(documentId);
    this.schedulers.get(documentId)?.dispose();
    this.schedulers.delete(documentId);
    this.operationQueues.get(documentId)?.dispose();
    this.operationQueues.delete(documentId);
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
    const expectedOpenDocument =
      session === undefined
        ? undefined
        : {
            relativePath: relativeDocumentPath(workspaceRoot, session.path),
            baseHash: session.baseHash,
          };
    const result =
      session === undefined
        ? await execute(undefined)
        : await this.runDocumentOperation(session.id, () =>
            execute(expectedOpenDocument),
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

  handleHistoryIssue(event: HistoryIssueEvent): void {
    const session = Object.values(this.store.getState().sessionsById).find(
      (candidate) =>
        candidate.id === event.documentId ||
        candidate.historyDocumentId === event.documentId,
    );
    if (session === undefined) {
      return;
    }
    this.patchSession(session.id, { historyIssue: event });
  }

  clearHistoryIssue(documentId: string): void {
    if (this.store.getState().sessionsById[documentId] === undefined) {
      return;
    }
    this.patchSession(documentId, { historyIssue: null });
  }

  async reloadFromDisk(documentId: string): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    await this.runDocumentOperation(documentId, async () => {
      const current = this.store.getState().sessionsById[documentId];
      if (current === undefined) return;
      const response = await this.gateway.open(current.path);
      const scene = deserializeSceneData(response.scene);
      this.schedulers.get(documentId)?.setConflicted(false);
      this.patchSession(documentId, {
        scene,
        sceneVersion: getSceneVersion(scene.elements),
        sessionGeneration: (current.sessionGeneration ?? 0) + 1,
        revision: current.revision + 1,
        baseHash: response.baseHash,
        saveState: "clean",
        conflictInfo: null,
        lastReloadedAt: Date.now(),
        errorMessage: null,
      });
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
    await this.runDocumentOperation(documentId, async () => {
      const current = this.store.getState().sessionsById[documentId];
      if (current === undefined) return;
      const response = await this.gateway.resolveConflict(
        current.path,
        resolution,
        saveAsPath,
      );
      this.schedulers.get(documentId)?.setConflicted(false);

      if (resolution === "takeExternal" && response.scene !== undefined) {
        const scene = deserializeSceneData(response.scene);
        this.patchSession(documentId, {
          scene,
          sceneVersion: getSceneVersion(scene.elements),
          sessionGeneration: (current.sessionGeneration ?? 0) + 1,
          revision: current.revision + 1,
          baseHash: response.newBaseHash,
          saveState: "clean",
          conflictInfo: null,
          errorMessage: null,
        });
        return;
      }
      if (resolution === "keepLocal") {
        this.patchSession(documentId, {
          sessionGeneration: (current.sessionGeneration ?? 0) + 1,
          baseHash: response.newBaseHash,
          saveState: "dirty",
          conflictInfo: null,
          errorMessage: null,
        });
        return;
      }
      if (saveAsPath === undefined) {
        throw new Error(
          "A destination is required to save the drawing as new.",
        );
      }
      const title = getFileName(saveAsPath);
      this.patchSession(documentId, {
        sessionGeneration: (current.sessionGeneration ?? 0) + 1,
        path: saveAsPath,
        title,
        baseHash: response.newBaseHash,
        saveState: "clean",
        conflictInfo: null,
        errorMessage: null,
      });
    });
  }

  async saveOrphanedAs(documentId: string, newPath: string): Promise<void> {
    const session = this.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    await this.runDocumentOperation(documentId, async () => {
      const current = this.store.getState().sessionsById[documentId];
      if (current === undefined) return;
      const response = await this.gateway.checkpoint(
        newPath,
        serializeScene(current.scene),
        "manualSave",
      );
      if (current.path.length > 0) {
        await this.gateway.close(current.path, "discardOrphan");
      }
      this.schedulers.get(documentId)?.setConflicted(false);
      const title = getFileName(newPath);
      this.patchSession(documentId, {
        sessionGeneration: (current.sessionGeneration ?? 0) + 1,
        path: newPath,
        title,
        baseHash: response.newBaseHash,
        saveState: "clean",
        conflictInfo: null,
        errorMessage: null,
      });
    });
  }

  dispose(): void {
    this.schedulers.forEach((scheduler) => scheduler.dispose());
    this.schedulers.clear();
    this.operationQueues.forEach((queue) => queue.dispose());
    this.operationQueues.clear();
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
      sessionGeneration: 0,
      revision: 0,
      baseHash,
      saveState,
      errorMessage: null,
      conflictInfo: null,
      historyIssue: null,
      lastReloadedAt: null,
    };

    const operationQueue = new DocumentOperationQueue();
    const scheduler = new DraftScheduler<SceneSnapshot>({
      operationQueue,
      persistDraft: async (nextScene) => {
        if (path.length === 0) {
          return;
        }
        this.patchSession(id, { saveState: "savingDraft" });
        const currentPath =
          this.store.getState().sessionsById[id]?.path ?? path;
        await this.gateway.saveDraft(currentPath, serializeScene(nextScene));
        if (this.store.getState().sessionsById[id]?.scene === nextScene) {
          this.patchSession(id, { saveState: "draftSaved" });
        }
      },
      checkpoint: async (nextScene, reason) => {
        if (path.length === 0) {
          return;
        }
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

    this.operationQueues.set(id, operationQueue);
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
    this.operationQueues.get(documentId)?.dispose();
    this.operationQueues.delete(documentId);
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

function isPathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return (
    path === normalizedRoot ||
    path.startsWith(`${normalizedRoot}/`) ||
    path.startsWith(`${normalizedRoot}\\`)
  );
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

/**
 * History errors are an independent event stream. They must remain attached
 * to the owning session instead of being reduced to a current-file save error.
 */
export async function registerDocumentHistoryEvents(
  manager: Pick<DocumentManager, "handleHistoryIssue">,
  listenForEvent: EventListener<"history-issue"> = defaultEventListener,
): Promise<() => void> {
  return listenForEvent("history-issue", ({ payload }) => {
    manager.handleHistoryIssue(payload);
  });
}

export function useDocumentStore<Selection>(
  selector: (state: DocumentStoreState) => Selection,
): Selection {
  return useStore(documentManager.store, selector);
}
