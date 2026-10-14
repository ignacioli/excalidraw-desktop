import { useEffect, useRef, useState } from "react";
import type { AppHandshakeResponse, RecoveryCandidate } from "../ipc/contracts";
import { documentManager, type DocumentManager } from "./documentStore";
import { RecoveryDialog, type RecoveryDecision } from "./RecoveryDialog";
import { recoveryManager, type RecoveryManager } from "./recoveryManager";
import { describeError, LocalizedError } from "../i18n/describeError";
import { t, useI18n } from "../i18n";

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

type StartupError =
  { kind: "check"; error: unknown } | { kind: "resolveFirst" };

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
  const { t } = useI18n();
  const [dismissedCount, setDismissedCount] = useState<number | null>(null);

  useEffect(() => {
    if (count <= 0) return;
    const timer = window.setTimeout(() => setDismissedCount(count), durationMs);
    return () => window.clearTimeout(timer);
  }, [count, durationMs]);

  if (count <= 0 || dismissedCount === count) return null;
  return (
    <p className="recovery-notice" role="status">
      <span aria-hidden="true" className="recovery-notice-dot" />
      {t(count === 1 ? "recovery.notice.one" : "recovery.notice.other", {
        count,
      })}
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
  const { t } = useI18n();
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [recoveredCount, setRecoveredCount] = useState(0);
  const handshakeRef = useRef<AppHandshakeResponse | null>(null);
  const startupPromiseRef = useRef<ReturnType<RecoveryManager["start"]> | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      startupPromiseRef.current = null;
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
    const startupPromise = manager.start();
    startupPromiseRef.current = startupPromise;
    void startupPromise
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
          setStartupError({ kind: "check", error });
        }
      });
    return () => {
      disposed = true;
      if (startupPromiseRef.current === startupPromise) {
        startupPromiseRef.current = null;
      }
    };
  }, [enabled, manager, onStateChange]);

  const apply = async (decision: RecoveryDecision) => {
    const pendingStartup = startupPromiseRef.current;
    if (pendingStartup !== null) {
      await pendingStartup;
    }
    const candidate = candidates.find(
      (item) => item.documentId === decision.documentId,
    );
    if (candidate === undefined) {
      throw new LocalizedError("recovery.error.snapshotUnavailable");
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

    const response = await manager.apply(appliedDecision, async (applied) => {
      if (
        applied.scene !== undefined &&
        applied.scene !== null &&
        candidate.originalPath !== null
      ) {
        await documents.restore(candidate.originalPath, applied.scene);
      } else if (applied.newPath !== undefined && applied.newPath !== null) {
        await documents.open(applied.newPath);
      }
    });
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
          {startupError.kind === "check"
            ? t("recovery.error.startupCheck", {
                reason: describeError(
                  startupError.error,
                  "error.recoveryFailed",
                ),
              })
            : t("recovery.error.resolveFirst")}
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <RecoveryDialog
          candidates={candidates}
          onApply={apply}
          onCancel={() => {
            setStartupError({ kind: "resolveFirst" });
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
        name: t("recovery.saveDialog.filterName"),
        extensions: ["excalidraw", "excalidraw.json"],
      },
    ],
    title: t("recovery.saveDialog.title"),
  });
}
