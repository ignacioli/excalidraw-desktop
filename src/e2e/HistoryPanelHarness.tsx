import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createTauriCommandInvoker } from "../ipc/client";
import { createHistoryClient } from "../history/historyClient";
import type { HistoryVersionView } from "../history/HistoryList";
import { HistoryPanel, type HistoryPanelStatus } from "../history/HistoryPanel";

type HarnessTab = "document-a" | "document-b";
type HarnessScenario = HistoryPanelStatus;

const DOCUMENT_PATHS: Record<HarnessTab, string> = {
  "document-a": "/e2e/history/document-a.excalidraw",
  "document-b": "/e2e/history/document-b.excalidraw",
};

const SCENARIOS: readonly { label: string; value: HarnessScenario }[] = [
  { label: "Available", value: "available" },
  { label: "Loading", value: "loading" },
  { label: "Empty", value: "empty" },
  { label: "Processing", value: "processing" },
  { label: "Permission denied", value: "permissionDenied" },
  { label: "Conflict", value: "conflict" },
  { label: "Resource unavailable", value: "resourceUnavailable" },
  { label: "Error", value: "error" },
];

/**
 * Browser-only entry for T023. It uses the public history client and the
 * browser Tauri harness; it is never enabled in a production build.
 */
export function HistoryPanelHarness() {
  const client = useMemo(
    () => createHistoryClient(createTauriCommandInvoker()),
    [],
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestSequence = useRef(0);
  const lastListRequest = useRef<string | null>(null);
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<HarnessTab>("document-a");
  const [scenario, setScenario] = useState<HarnessScenario>("available");
  const [pageSize, setPageSize] = useState<50 | 100>(50);
  const [items, setItems] = useState<HistoryVersionView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [listBusy, setListBusy] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<
    "loading" | "ready" | "error"
  >("ready");
  const [previewContent, setPreviewContent] = useState<ReactNode>(null);

  useEffect(() => {
    if (!open || scenario !== "available") return;
    const key = `${tab}:${pageSize}`;
    if (lastListRequest.current === key) return;
    lastListRequest.current = key;
    setListBusy(true);
    setItems([]);
    setNextCursor(undefined);
    void client
      .list({
        document: { kind: "path", path: DOCUMENT_PATHS[tab] },
        limit: pageSize,
      })
      .then((response) => {
        setItems(
          response.items.map((item) => ({ ...item, ...itemView(item) })),
        );
        setNextCursor(response.nextCursor);
      })
      .catch(() => {
        setScenario("error");
      })
      .finally(() => setListBusy(false));
  }, [client, open, pageSize, scenario, tab]);

  const cancelPreview = () => {
    requestSequence.current += 1;
    setPreviewVersionId(null);
    setPreviewState("ready");
    setPreviewContent(null);
  };

  const handleTabChange = (nextTab: HarnessTab) => {
    requestSequence.current += 1;
    setTab(nextTab);
    setPreviewVersionId(null);
    setPreviewState("ready");
    setPreviewContent(null);
    lastListRequest.current = null;
  };

  const handlePreview = (item: HistoryVersionView) => {
    const requestId = ++requestSequence.current;
    const requestTab = tab;
    setPreviewVersionId(item.versionId);
    setPreviewState("loading");
    setPreviewContent(null);
    void client
      .preview({
        document: { kind: "path", path: DOCUMENT_PATHS[requestTab] },
        versionId: item.versionId,
      })
      .then((response) => {
        if (requestId !== requestSequence.current || requestTab !== tab) return;
        setPreviewContent(
          <p aria-label="Preview scene">
            Read-only scene for {response.versionId}; current canvas unchanged.
          </p>,
        );
        setPreviewState("ready");
      })
      .catch(() => {
        if (requestId !== requestSequence.current || requestTab !== tab) return;
        setPreviewState("error");
      });
  };

  const loadNextPage = () => {
    if (nextCursor === undefined || listBusy) return;
    setListBusy(true);
    void client
      .list({
        document: { kind: "path", path: DOCUMENT_PATHS[tab] },
        cursor: nextCursor,
        limit: pageSize,
      })
      .then((response) => {
        setItems((current) => [
          ...current,
          ...response.items.map((item) => ({ ...item, ...itemView(item) })),
        ]);
        setNextCursor(response.nextCursor);
      })
      .finally(() => setListBusy(false));
  };

  const onScenarioChange = (nextScenario: HarnessScenario) => {
    requestSequence.current += 1;
    setPreviewVersionId(null);
    setPreviewState("ready");
    setPreviewContent(null);
    setScenario(nextScenario);
    if (nextScenario === "available") lastListRequest.current = null;
  };

  const panelStatus =
    scenario === "available" ? (listBusy ? "loading" : "available") : scenario;

  return (
    <main className="history-e2e-harness">
      <header aria-label="History semantic test controls">
        <h1>Local Version History browser harness</h1>
        <div>
          <button
            aria-label="Open version history"
            onClick={() => setOpen(true)}
            ref={triggerRef}
            type="button"
          >
            Open version history
          </button>
          <button
            aria-label="Use document A"
            aria-pressed={tab === "document-a"}
            onClick={() => handleTabChange("document-a")}
            type="button"
          >
            Document A
          </button>
          <button
            aria-label="Use document B"
            aria-pressed={tab === "document-b"}
            onClick={() => handleTabChange("document-b")}
            type="button"
          >
            Document B
          </button>
          <label>
            Page size
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value) as 50 | 100);
                lastListRequest.current = null;
              }}
            >
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
          <label>
            State
            <select
              value={scenario}
              onChange={(event) =>
                onScenarioChange(event.target.value as HarnessScenario)
              }
            >
              {SCENARIOS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {nextCursor !== undefined ? (
            <button disabled={listBusy} onClick={loadNextPage} type="button">
              Load next page
            </button>
          ) : null}
        </div>
      </header>
      {open ? (
        <HistoryPanel
          currentVersionId="v-000"
          fileName={`${tab}.excalidraw`}
          items={items}
          onClose={() => setOpen(false)}
          onExitPreview={cancelPreview}
          onPreview={handlePreview}
          onRestore={() => undefined}
          previewContent={previewContent}
          previewState={previewState}
          previewVersionId={previewVersionId}
          processing={listBusy}
          status={panelStatus}
          statusMessage={
            scenario === "error"
              ? "The history service returned a deterministic test error."
              : undefined
          }
          triggerRef={triggerRef}
        />
      ) : null}
    </main>
  );
}

function itemView(item: {
  versionId: string;
}): Pick<HistoryVersionView, "summary" | "summaryReliable"> {
  if (item.versionId === "v-000") {
    return { summary: "Current saved drawing", summaryReliable: true };
  }
  if (item.versionId === "v-001") {
    return { summary: "Added title", summaryReliable: true };
  }
  if (item.versionId === "v-002") {
    return { summary: "Before restore", summaryReliable: true };
  }
  return { summary: "Canvas changed", summaryReliable: false };
}
