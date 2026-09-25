import type {
  HistoryDocumentLocator,
  HistoryMarkResponse,
  HistoryOperationStatusResponse,
  HistoryReplaceResponse,
  HistoryReplaceTarget,
} from "../ipc/contracts";
import {
  deserializeSceneData,
  serializeScene,
  type SceneSnapshot,
} from "../editor/sceneSerializer";
import {
  HistoryReplaceResponseLostError,
  HistoryReplaceStatusError,
} from "./historyClient";
import type {
  DocumentManager,
  DocumentOperationContext,
  DocumentSessionVersion,
} from "../documents/documentStore";
import type { HistoryClient } from "./types";
import { importTarget, type ImportedSceneCandidate } from "./importProtection";

export interface HistoryAdoptionContext {
  documentId: string;
  capturedVersion: DocumentSessionVersion;
  response: Extract<HistoryReplaceResponse, { status: "completed" }>;
  /**
   * Final session mutation seam. Adopters must call this only after async
   * asset adoption completes; DocumentManager repeats the generation/active
   * tab guards at the actual mutation point.
   */
  commit: (scene: SceneSnapshot) => boolean;
}

export type HistorySceneAdopter = (
  scene: SceneSnapshot,
  context: HistoryAdoptionContext,
) => boolean | Promise<boolean>;

export interface HistoryReplacementResult {
  response: HistoryReplaceResponse;
  adopted: boolean;
}

export interface HistoryReplacementOptions {
  /** Reuse the existing Save As/first-save flow for an untitled session. */
  prepareUnsaved?: HistoryMarkSaveHandler;
}

export class HistoryReplacementRequiresSaveError extends Error {
  constructor() {
    super("An untitled drawing must be saved before it can be replaced.");
    this.name = "HistoryReplacementRequiresSaveError";
  }
}

export class HistoryReplacementCancelledError extends Error {
  constructor() {
    super("The first save was cancelled; the drawing was not replaced.");
    this.name = "HistoryReplacementCancelledError";
  }
}

export type HistoryReplacementBlockedReason = "conflict";

export class HistoryReplacementBlockedError extends Error {
  readonly reason: HistoryReplacementBlockedReason;

  constructor(reason: HistoryReplacementBlockedReason) {
    super(
      reason === "conflict"
        ? "Resolve the file conflict before replacing the drawing."
        : "The drawing cannot be replaced.",
    );
    this.name = "HistoryReplacementBlockedError";
    this.reason = reason;
  }
}

/**
 * Immutable state captured at the moment the user pressed Mark. The scene
 * JSON is intentionally retained separately from the live session so edits
 * made while the mark request is in flight cannot change the version being
 * published.
 */
export interface HistoryMarkCapture {
  documentId: string;
  document: HistoryDocumentLocator;
  path: string;
  scene: SceneSnapshot;
  sceneJson: string;
  sessionGeneration: number;
  revision: number;
}

export interface HistoryMarkSaveOutcome {
  status: "saved" | "cancelled";
  document?: HistoryDocumentLocator;
  sessionGeneration?: number;
  revision?: number;
}

export type HistoryMarkSaveHandler = (
  capture: HistoryMarkCapture,
) => Promise<HistoryMarkSaveOutcome | void> | HistoryMarkSaveOutcome | void;

export interface HistoryMarkOptions {
  requestId?: string;
  /**
   * Existing Save As/first-save flow supplied by the shell for untitled
   * documents. The coordinator never opens a named history dialog and never
   * mutates the canvas while preparing the document.
   */
  prepareUnsaved?: HistoryMarkSaveHandler;
}

export interface HistoryMarkResult {
  status: "marked";
  response: HistoryMarkResponse;
  captured: HistoryMarkCapture;
}

export interface HistoryMarkCancelledResult {
  status: "cancelled";
  captured: HistoryMarkCapture;
}

export type HistoryMarkOutcome = HistoryMarkResult | HistoryMarkCancelledResult;

export class HistoryMarkRequiresSaveError extends Error {
  constructor() {
    super("An untitled drawing must be saved before it can be marked.");
    this.name = "HistoryMarkRequiresSaveError";
  }
}

/**
 * Coordinates one document's destructive history replacement. The manager
 * owns queue/freeze/session guards; the adopter owns the editor-specific
 * asset adoption seam. This module never calls the replacement command twice.
 */
export class HistoryCoordinator {
  private readonly adoptedRequestIds = new Set<string>();
  private readonly pendingContexts = new Map<
    string,
    DocumentOperationContext
  >();
  private readonly deferredCompletions = new Map<
    string,
    {
      documentId: string;
      context: DocumentOperationContext;
      response: Extract<HistoryReplaceResponse, { status: "completed" }>;
    }
  >();

  constructor(
    private readonly manager: DocumentManager,
    private readonly client: HistoryClient,
    private readonly adoptScene: HistorySceneAdopter,
  ) {}

  /**
   * Publish a manual history version without freezing or replacing the live
   * canvas. The capture happens synchronously before any await; a successful
   * result is returned only after history_mark has durably replied.
   */
  async mark(
    documentId: string,
    options: HistoryMarkOptions = {},
  ): Promise<HistoryMarkOutcome> {
    const capture = this.captureMark(documentId);
    let document = capture.document;
    let sessionGeneration = capture.sessionGeneration;
    let revision = capture.revision;

    if (capture.path.length === 0) {
      if (options.prepareUnsaved === undefined) {
        throw new HistoryMarkRequiresSaveError();
      }
      const prepared = await options.prepareUnsaved(capture);
      if (prepared !== undefined && prepared.status === "cancelled") {
        return { status: "cancelled", captured: capture };
      }
      const current = this.manager.store.getState().sessionsById[documentId];
      if (current === undefined) {
        throw new HistoryMarkRequiresSaveError();
      }
      if (prepared?.document !== undefined) {
        document = prepared.document;
      } else if (current.path.length > 0) {
        document =
          current.historyDocumentId === undefined
            ? { kind: "path", path: current.path }
            : { kind: "handle", documentId: current.historyDocumentId };
      } else {
        throw new HistoryMarkRequiresSaveError();
      }
      sessionGeneration =
        prepared?.sessionGeneration ?? current.sessionGeneration ?? 0;
      revision = prepared?.revision ?? current.revision;
    }

    const response = await this.manager.runDocumentOperation(
      documentId,
      async () =>
        this.client.mark({
          document,
          requestId: options.requestId ?? createRequestId(),
          sessionGeneration,
          revision,
          currentSceneJson: capture.sceneJson,
        }),
    );
    return { status: "marked", response, captured: capture };
  }

  async replace(
    documentId: string,
    target: HistoryReplaceTarget,
    requestId = createRequestId(),
    options: HistoryReplacementOptions = {},
  ): Promise<HistoryReplacementResult> {
    const preparedDocument = await this.prepareReplacement(documentId, options);
    const current = this.manager.store.getState().sessionsById[documentId];
    if (
      current !== undefined &&
      (current.saveState === "conflicted" || current.conflictInfo !== null)
    ) {
      throw new HistoryReplacementBlockedError("conflict");
    }
    let adopted = false;
    const response = await this.manager.runHistoryReplacement(
      documentId,
      async (context) => {
        const session = this.manager.store.getState().sessionsById[documentId];
        if (session === undefined) {
          throw new Error(`Document ${documentId} is not open.`);
        }
        const request = {
          document:
            preparedDocument ??
            (session.historyDocumentId === undefined
              ? { kind: "path" as const, path: session.path }
              : {
                  kind: "handle" as const,
                  documentId: session.historyDocumentId,
                }),
          requestId,
          sessionGeneration: context.sessionGeneration,
          revision: context.revision,
          expectedBaseHash: context.baseHash,
          currentSceneJson: serializeScene(session.scene),
          target,
        };
        let result: HistoryReplaceResponse;
        try {
          result = await this.client.replace(request);
        } catch (error) {
          if (error instanceof HistoryReplaceResponseLostError) {
            this.pendingContexts.set(requestId, context);
            this.manager.retainHistoryPending(documentId, requestId);
          } else {
            this.clearPending(documentId, requestId);
          }
          throw error;
        }
        if (result.status === "pendingReconciliation") {
          this.pendingContexts.set(requestId, context);
          this.manager.retainHistoryPending(documentId, requestId);
        }
        adopted = await this.adoptCompleted(documentId, context, result);
        return result;
      },
    );
    return { response, adopted };
  }

  /** Clear/reset uses the same protected replacement transaction exactly once. */
  async clear(
    documentId: string,
    requestId = createRequestId(),
    options: HistoryReplacementOptions = {},
  ): Promise<HistoryReplacementResult> {
    return this.replace(documentId, { kind: "clear" }, requestId, options);
  }

  /** Alias used by reset commands; it must not create a second transaction. */
  async reset(
    documentId: string,
    requestId = createRequestId(),
    options: HistoryReplacementOptions = {},
  ): Promise<HistoryReplacementResult> {
    return this.clear(documentId, requestId, options);
  }

  /**
   * Import callers must parse through importProtection first. Accepting its
   * canonical candidate here keeps arbitrary frontend strings out of this
   * convenience path while the Rust boundary still validates the payload.
   */
  async replaceImportedScene(
    documentId: string,
    candidate: ImportedSceneCandidate,
    requestId = createRequestId(),
    options: HistoryReplacementOptions = {},
  ): Promise<HistoryReplacementResult> {
    return this.replace(
      documentId,
      importTarget(candidate),
      requestId,
      options,
    );
  }

  /** Resolve a pending/uncertain operation without issuing another replace. */
  async resolvePending(
    documentId: string,
    requestId: string,
  ): Promise<HistoryReplacementResult> {
    let adopted = false;
    const response = await this.manager.runHistoryStatus(
      documentId,
      async () => {
        const session = this.manager.store.getState().sessionsById[documentId];
        if (session === undefined) {
          throw new Error(`Document ${documentId} is not open.`);
        }
        const document =
          session.historyDocumentId === undefined
            ? { kind: "path" as const, path: session.path }
            : {
                kind: "handle" as const,
                documentId: session.historyDocumentId,
              };
        let result: HistoryOperationStatusResponse;
        try {
          result = await this.client.operationStatus({ document, requestId });
        } catch (error) {
          if (error instanceof HistoryReplaceResponseLostError) {
            this.manager.retainHistoryPending(documentId, requestId);
          } else {
            this.clearPending(documentId, requestId);
          }
          throw error;
        }
        const capturedContext = this.pendingContexts.get(requestId);
        if (result.state === "aborted" || result.state === "conflict") {
          this.clearPending(documentId, requestId);
          throw new HistoryReplaceStatusError(result);
        }
        if (result.state === "completed") {
          if (capturedContext !== undefined) {
            adopted = await this.adoptCompleted(
              documentId,
              capturedContext,
              result,
            );
          }
          if (adopted) {
            this.clearPending(documentId, requestId);
          } else {
            this.manager.retainHistoryPending(documentId, requestId);
          }
        } else {
          this.manager.retainHistoryPending(documentId, requestId);
        }
        return result;
      },
      requestId,
    );
    return { response: statusAsReplacementResponse(response), adopted };
  }

  /** Apply a completed operation deferred while its tab was inactive. */
  async adoptDeferred(documentId: string): Promise<boolean> {
    const deferred = [...this.deferredCompletions.values()].find(
      (entry) => entry.documentId === documentId,
    );
    if (deferred === undefined) {
      return false;
    }
    const adopted = await this.manager.runDocumentOperation(
      documentId,
      async () =>
        this.adoptCompleted(documentId, deferred.context, deferred.response),
    );
    if (adopted) {
      this.clearPending(documentId, deferred.response.requestId);
      this.deferredCompletions.delete(deferred.response.requestId);
    }
    return adopted;
  }

  private async adoptCompleted(
    documentId: string,
    context: DocumentOperationContext,
    response: HistoryReplaceResponse | HistoryOperationStatusResponse,
  ): Promise<boolean> {
    const responseRequestId = response.requestId;
    if (this.adoptedRequestIds.has(responseRequestId)) {
      return false;
    }
    if ("state" in response) {
      if (
        response.state !== "completed" ||
        response.replacementCommitted !== true ||
        response.adoptedScene === undefined ||
        response.newBaseHash === undefined ||
        response.newSessionGeneration === undefined
      ) {
        return false;
      }
      const completedResponse: Extract<
        HistoryReplaceResponse,
        { status: "completed" }
      > = {
        status: "completed",
        requestId: response.requestId,
        replacementCommitted: true,
        protectionVersionId: response.protectionVersionId ?? "",
        adoptedScene: response.adoptedScene,
        newBaseHash: response.newBaseHash,
        newSessionGeneration: response.newSessionGeneration,
      };
      if (
        !context.isCurrent() ||
        this.manager.store.getState().activeDocumentId !== documentId
      ) {
        this.deferCompleted(documentId, context, completedResponse);
        return false;
      }
      return this.finishAdoption(
        documentId,
        context,
        responseRequestId,
        completedResponse,
      );
    }
    if (
      response.status !== "completed" ||
      response.replacementCommitted !== true
    ) {
      return false;
    }
    if (
      !context.isCurrent() ||
      this.manager.store.getState().activeDocumentId !== documentId
    ) {
      this.deferCompleted(documentId, context, response);
      return false;
    }
    return this.finishAdoption(
      documentId,
      context,
      responseRequestId,
      response,
    );
  }

  private captureMark(documentId: string): HistoryMarkCapture {
    const session = this.manager.store.getState().sessionsById[documentId];
    if (session === undefined) {
      throw new Error(`Document ${documentId} is not open.`);
    }
    return {
      documentId,
      document:
        session.historyDocumentId === undefined
          ? { kind: "path", path: session.path }
          : { kind: "handle", documentId: session.historyDocumentId },
      path: session.path,
      scene: session.scene,
      sceneJson: serializeScene(session.scene),
      sessionGeneration: session.sessionGeneration ?? 0,
      revision: session.revision,
    };
  }

  private async prepareReplacement(
    documentId: string,
    options: HistoryReplacementOptions,
  ): Promise<HistoryDocumentLocator | undefined> {
    const current = this.manager.store.getState().sessionsById[documentId];
    if (current === undefined) {
      throw new Error(`Document ${documentId} is not open.`);
    }
    if (current.path.length > 0) {
      return current.historyDocumentId === undefined
        ? { kind: "path", path: current.path }
        : { kind: "handle", documentId: current.historyDocumentId };
    }
    if (options.prepareUnsaved === undefined) {
      throw new HistoryReplacementRequiresSaveError();
    }
    const capture = this.captureMark(documentId);
    const prepared = await options.prepareUnsaved(capture);
    if (prepared?.status === "cancelled") {
      throw new HistoryReplacementCancelledError();
    }
    const updated = this.manager.store.getState().sessionsById[documentId];
    if (prepared?.document !== undefined) {
      return prepared.document;
    }
    if (updated?.path.length === 0) {
      throw new HistoryReplacementRequiresSaveError();
    }
    return updated === undefined
      ? undefined
      : updated.historyDocumentId === undefined
        ? { kind: "path", path: updated.path }
        : { kind: "handle", documentId: updated.historyDocumentId };
  }

  private async finishAdoption(
    documentId: string,
    context: DocumentOperationContext,
    responseRequestId: string,
    response: Extract<HistoryReplaceResponse, { status: "completed" }>,
  ): Promise<boolean> {
    let didAdopt: boolean;
    let committed = false;
    try {
      didAdopt = await this.adoptScene(
        deserializeSceneData(response.adoptedScene),
        {
          documentId,
          capturedVersion: context,
          response,
          commit: (scene) => {
            if (
              !context.isCurrent() ||
              this.manager.store.getState().activeDocumentId !== documentId
            ) {
              return false;
            }
            committed = this.manager.adoptHistoryScene(
              documentId,
              context,
              scene,
              response.newBaseHash,
              response.newSessionGeneration,
            );
            return committed;
          },
        },
      );
    } catch {
      this.deferCompleted(documentId, context, response);
      return false;
    }
    // Asset adoption is asynchronous. Re-check both guards after it returns,
    // immediately before the coordinator considers the session mutation
    // committed; a late tab switch or edit must stay deferred/frozen.
    if (!didAdopt || !committed) {
      this.deferCompleted(documentId, context, response);
      return false;
    }
    this.adoptedRequestIds.add(responseRequestId);
    return true;
  }

  private deferCompleted(
    documentId: string,
    context: DocumentOperationContext,
    response: Extract<HistoryReplaceResponse, { status: "completed" }>,
  ): void {
    this.deferredCompletions.set(response.requestId, {
      documentId,
      context,
      response,
    });
    this.manager.retainHistoryPending(documentId, response.requestId);
  }

  private clearPending(documentId: string, requestId: string): void {
    this.manager.releaseHistoryPending(documentId, requestId);
    this.pendingContexts.delete(requestId);
    this.deferredCompletions.delete(requestId);
  }
}

function statusAsReplacementResponse(
  status: Awaited<ReturnType<HistoryClient["operationStatus"]>>,
): HistoryReplaceResponse {
  if (
    status.state === "completed" &&
    status.replacementCommitted === true &&
    status.adoptedScene !== undefined &&
    status.newBaseHash !== undefined &&
    status.newSessionGeneration !== undefined
  ) {
    return {
      status: "completed",
      requestId: status.requestId,
      replacementCommitted: true,
      protectionVersionId: status.protectionVersionId ?? "",
      adoptedScene: status.adoptedScene,
      newBaseHash: status.newBaseHash,
      newSessionGeneration: status.newSessionGeneration,
    };
  }
  return {
    status: "pendingReconciliation",
    requestId: status.requestId,
    replacementCommitted: null,
    operationState: "pendingReconciliation",
  };
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `history-${Date.now()}`;
}
