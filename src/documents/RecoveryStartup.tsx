import { useEffect, useRef, useState } from "react";
import type { AppHandshakeResponse, RecoveryCandidate } from "../ipc/contracts";
import { documentManager, type DocumentManager } from "./documentStore";
import { RecoveryDialog, type RecoveryDecision } from "./RecoveryDialog";
import { recoveryManager, type RecoveryManager } from "./recoveryManager";

interface RecoveryStartupProps {
  enabled: boolean;
  manager?: RecoveryManager;
  documents?: Pick<DocumentManager, "open" | "restore">;
  requestSaveAsPath?: (candidate: RecoveryCandidate) => Promise<string | null>;
  onStateChange?: (state: RecoveryStartupState) => void;
}

interface RecoveryNoticeProps {
  count: number;
  durationMs?: number;
}

export type RecoveryStartupStatus = "checking" | "dialog" | "ready" | "error";

export interface RecoveryStartupState {
  status: RecoveryStartupStatus;
  handshake: AppHandshakeResponse | null;
  candidates: readonly RecoveryCandidate[];
  recoveredCount: number;
}

export function RecoveryNotice({
  count,
  durationMs = 5_000,
}: RecoveryNoticeProps) {
  const [dismissedCount, setDismissedCount] = useState<number | null>(null);

  useEffect(() => {
    if (count <= 0) return;
    const timer = window.setTimeout(
      () => setDismissedCount(count),
      durationMs,
    );
    return () => window.clearTimeout(timer);
  }, [count, durationMs]);

  if (count <= 0 || dismissedCount === count) return null;
  return (
    <p className="recovery-notice" role="status">
      <span aria-hidden="true" className="recovery-notice-dot" />
      Recovered · {count} {count === 1 ? "drawing" : "drawings"} restored
    </p>
  );
}

export function RecoveryStartup({
  enabled,
  manager = recoveryManager,
  documents = documentManager,
  requestSaveAsPath = chooseRecoveryPath,
  onStateChange,
}: RecoveryStartupProps) {
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [recoveredCount, setRecoveredCount] = useState(0);
  const handshakeRef = useRef<AppHandshakeResponse | null>(null);

  useEffect(() => {
    if (!enabled) {
      onStateChange?.({
        status: "ready",
        handshake: null,
        candidates: [],
        recoveredCount: 0,
      });
      return;
    }
    onStateChange?.({
      status: "checking",
      handshake: null,
      candidates: [],
      recoveredCount: 0,
    });
    let disposed = false;
    void manager
      .start()
      .then((result) => {
        if (disposed) {
          return;
        }
        handshakeRef.current = result.handshake;
        setCandidates(result.candidates);
        onStateChange?.({
          status: result.dialogRequired ? "dialog" : "ready",
          handshake: result.handshake,
          candidates: result.candidates,
          recoveredCount: 0,
        });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          onStateChange?.({
            status: "error",
            handshake: handshakeRef.current,
            candidates: [],
            recoveredCount: 0,
          });
          setStartupError(getErrorMessage(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [enabled, manager, onStateChange]);

  const apply = async (decision: RecoveryDecision) => {
    const candidate = candidates.find(
      (item) => item.documentId === decision.documentId,
    );
    if (candidate === undefined) {
      throw new Error("The selected recovery snapshot is no longer available.");
    }

    let appliedDecision = decision;
    if (
      decision.action === "restore" &&
      (candidate.originalPath === null || candidate.coldFileMtime === null)
    ) {
      const saveAsPath = await requestSaveAsPath(candidate);
      if (saveAsPath === null) {
        return;
      }
      appliedDecision = {
        documentId: decision.documentId,
        action: "saveAsNew",
        saveAsPath,
      };
    }

    const response = await manager.apply(appliedDecision);
    if (
      response.scene !== undefined &&
      response.scene !== null &&
      candidate.originalPath !== null
    ) {
      await documents.restore(candidate.originalPath, response.scene);
    } else if (response.newPath !== undefined && response.newPath !== null) {
      await documents.open(response.newPath);
    }
    const recovered =
      (response.scene !== undefined &&
        response.scene !== null &&
        candidate.originalPath !== null) ||
      (response.newPath !== undefined && response.newPath !== null);
    const nextRecoveredCount = recovered ? recoveredCount + 1 : recoveredCount;
    const nextCandidates = candidates.filter(
      (item) => item.documentId !== decision.documentId,
    );
    setRecoveredCount(nextRecoveredCount);
    setCandidates(nextCandidates);
    onStateChange?.({
      status: nextCandidates.length > 0 ? "dialog" : "ready",
      handshake: handshakeRef.current,
      candidates: nextCandidates,
      recoveredCount: nextRecoveredCount,
    });
    return response;
  };

  return (
    <>
      {startupError !== null ? (
        <p className="recovery-startup-error" role="alert">
          Recovery snapshots could not be checked: {startupError}
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <RecoveryDialog
          candidates={candidates}
          onApply={apply}
          onCancel={() => {
            setStartupError("Resolve recovery candidates before continuing.");
          }}
          requestSaveAsPath={requestSaveAsPath}
        />
      ) : null}
    </>
  );
}

async function chooseRecoveryPath(
  candidate: RecoveryCandidate,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: candidate.displayName,
    filters: [
      {
        name: "Excalidraw drawing",
        extensions: ["excalidraw", "excalidraw.json"],
      },
    ],
    title: "Save recovered drawing",
  });
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
  return "Unknown recovery error";
}
