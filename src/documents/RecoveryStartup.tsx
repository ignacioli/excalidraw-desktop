import { useEffect, useState } from "react";
import type { RecoveryCandidate } from "../ipc/contracts";
import { documentManager, type DocumentManager } from "./documentStore";
import { RecoveryDialog, type RecoveryDecision } from "./RecoveryDialog";
import { recoveryManager, type RecoveryManager } from "./recoveryManager";

interface RecoveryStartupProps {
  enabled: boolean;
  manager?: RecoveryManager;
  documents?: Pick<DocumentManager, "open" | "restore">;
  requestSaveAsPath?: (candidate: RecoveryCandidate) => Promise<string | null>;
}

export function RecoveryStartup({
  enabled,
  manager = recoveryManager,
  documents = documentManager,
  requestSaveAsPath = chooseRecoveryPath,
}: RecoveryStartupProps) {
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let disposed = false;
    void manager
      .start()
      .then((result) => {
        if (!disposed && result.dialogRequired) {
          setCandidates(result.candidates);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setStartupError(getErrorMessage(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [enabled, manager]);

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
    setCandidates((current) =>
      current.filter((item) => item.documentId !== decision.documentId),
    );
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
          onCancel={() => setCandidates([])}
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
