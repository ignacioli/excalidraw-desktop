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
  invoker: CommandInvoker = createTauriCommandInvoker(),
): RecoveryGateway {
  return {
    handshake: () => invoker.invoke("app_handshake", {}),
    list: () => invoker.invoke("recovery_list", {}),
    apply: (decision) => invoker.invoke("recovery_apply", decision),
  };
}

export class RecoveryManager {
  private readonly gateway: RecoveryGateway;
  private readonly onSceneLoaded:
    RecoveryManagerOptions["onSceneLoaded"] | undefined;

  constructor(
    gateway: RecoveryGateway = createRecoveryGateway(),
    options: RecoveryManagerOptions = {},
  ) {
    this.gateway = gateway;
    this.onSceneLoaded = options.onSceneLoaded;
  }

  async start(): Promise<RecoveryStartupResult> {
    const handshake = await this.gateway.handshake();
    if (!handshake.abnormalExit) {
      return {
        handshake,
        candidates: [],
        dialogRequired: false,
      };
    }

    const candidates = await this.gateway.list();
    return {
      handshake,
      candidates,
      dialogRequired: candidates.length > 0,
    };
  }

  async apply(decision: RecoveryDecision): Promise<RecoveryApplyResponse> {
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
    return response;
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
