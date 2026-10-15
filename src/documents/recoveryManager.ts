import { loadStartupHandshake } from "../app/startupRoute";
import { createTauriCommandInvoker, type CommandInvoker } from "../ipc/client";
import type {
  AppHandshakeResponse,
  CommandResponse,
  RecoveryAction,
  RecoveryCandidate,
  SceneData,
} from "../ipc/contracts";

export interface RecoveryDecision {
  documentId: string;
  action: RecoveryAction;
  saveAsPath?: string;
}

export interface RecoveryGateway {
  handshake(): Promise<AppHandshakeResponse>;
  list(): Promise<RecoveryCandidate[]>;
  apply(decision: RecoveryDecision): Promise<RecoveryApplyResponse>;
  /** Recovery is finished; the backend opens the other windows. */
  done(): Promise<void>;
}

export type RecoveryApplyResponse = CommandResponse<"recovery_apply">;

export interface RecoveryAppliedAction {
  decision: RecoveryDecision;
  response: RecoveryApplyResponse;
}

export interface RecoveryStartupResult {
  handshake: AppHandshakeResponse;
  candidates: RecoveryCandidate[];
  dialogRequired: boolean;
  cancelled?: boolean;
  applied?: RecoveryAppliedAction;
}

export interface RecoveryFlowHost {
  chooseDecision: (
    candidates: readonly RecoveryCandidate[],
  ) => Promise<RecoveryDecision | null>;
}

export interface RecoveryManagerOptions {
  onSceneLoaded?: (
    documentId: string,
    scene: SceneData,
    newPath: string | undefined,
  ) => void | Promise<void>;
}

export function createRecoveryGateway(
  providedInvoker?: CommandInvoker,
): RecoveryGateway {
  const invoker = providedInvoker ?? createTauriCommandInvoker();
  return {
    handshake: () => loadStartupHandshake(providedInvoker),
    list: () => invoker.invoke("recovery_list", {}),
    apply: (decision) => invoker.invoke("recovery_apply", decision),
    done: async () => {
      await invoker.invoke("startup_recovery_done", {});
    },
  };
}

export class RecoveryManager {
  private readonly gateway: RecoveryGateway;
  private readonly onSceneLoaded:
    RecoveryManagerOptions["onSceneLoaded"] | undefined;
  /**
   * `app_handshake` is the startup barrier: the native setup completes
   * history-operation reconciliation before the command can be served. Keep
   * one in-flight startup promise so a recovery action cannot race that
   * barrier when a caller invokes `apply` while startup is still checking.
   */
  private startupPromise: Promise<RecoveryStartupResult> | null = null;
  /** Candidates not decided yet, after an abnormal exit. */
  private remaining: Set<string> | null = null;
  private finished: Promise<void> | null = null;

  constructor(
    gateway: RecoveryGateway = createRecoveryGateway(),
    options: RecoveryManagerOptions = {},
  ) {
    this.gateway = gateway;
    this.onSceneLoaded = options.onSceneLoaded;
  }

  async start(): Promise<RecoveryStartupResult> {
    if (this.startupPromise !== null) {
      return this.startupPromise;
    }
    this.startupPromise = this.loadStartup();
    try {
      return await this.startupPromise;
    } catch (error) {
      this.startupPromise = null;
      throw error;
    }
  }

  private async loadStartup(): Promise<RecoveryStartupResult> {
    const handshake = await this.gateway.handshake();
    if (!handshake.abnormalExit) {
      return {
        handshake,
        candidates: [],
        dialogRequired: false,
      };
    }

    const candidates = await this.gateway.list();
    this.remaining = new Set(
      candidates.map((candidate) => candidate.documentId),
    );
    if (candidates.length === 0) await this.finish();
    return {
      handshake,
      candidates,
      dialogRequired: candidates.length > 0,
    };
  }

  /**
   * Apply one decision. `adopt` opens the result in this window; the
   * decision counts as made only once it has, so the windows of the
   * previous session never take a drawing that is still being restored here.
   */
  async apply(
    decision: RecoveryDecision,
    adopt?: (response: RecoveryApplyResponse) => Promise<void> | void,
  ): Promise<RecoveryApplyResponse> {
    // RecoveryStartup only renders a decision after `start`, but this guard
    // also covers native menu/event callers that arrive during startup.
    if (this.startupPromise !== null) {
      await this.startupPromise;
    }
    const response = await this.gateway.apply(decision);
    if (
      response.scene !== undefined &&
      response.scene !== null &&
      this.onSceneLoaded !== undefined
    ) {
      await this.onSceneLoaded(
        decision.documentId,
        response.scene,
        response.newPath,
      );
    }
    await adopt?.(response);
    if (this.remaining?.delete(decision.documentId) === true) {
      if (this.remaining.size === 0) await this.finish();
    }
    return response;
  }

  /**
   * Tell the backend once that every candidate was decided, so it opens the
   * windows of the previous session. A failed call rejects the decision that
   * finished Recovery and is not cached.
   */
  private finish(): Promise<void> {
    if (this.finished === null) {
      const pending = this.gateway.done();
      this.finished = pending;
      pending.catch(() => {
        if (this.finished === pending) this.finished = null;
      });
    }
    return this.finished;
  }

  async run(host?: RecoveryFlowHost): Promise<RecoveryStartupResult> {
    const startup = await this.start();
    if (!startup.dialogRequired || host === undefined) {
      return startup;
    }

    const decision = await host.chooseDecision(startup.candidates);
    if (decision === null) {
      return { ...startup, cancelled: true };
    }

    const response = await this.apply(decision);
    return {
      ...startup,
      dialogRequired: false,
      applied: { decision, response },
    };
  }
}

export const recoveryManager = new RecoveryManager();
