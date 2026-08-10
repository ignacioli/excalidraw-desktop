import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import type { ResolvedColorScheme } from "../app/theme/types";
import { useAppStore } from "../app/store";
import { ExcalidrawAdapter } from "./ExcalidrawAdapter";
import { resolveAssetFiles } from "./assetResolver";
import { ImeBridge } from "./imeBridge";
import type { SceneSnapshot } from "./sceneSerializer";

interface ExcalidrawEditorProps {
  documentId: string;
  initialScene: SceneSnapshot;
  theme: ResolvedColorScheme;
  readOnly?: boolean;
  onSceneChange: (scene: SceneSnapshot) => void;
  onReady?: (
    documentId: string,
    adapter: ExcalidrawAdapter,
    container: HTMLDivElement,
  ) => void;
}

export function ExcalidrawEditor({
  documentId,
  initialScene,
  theme,
  readOnly = false,
  onSceneChange,
  onReady,
}: ExcalidrawEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<ExcalidrawAdapter | undefined>(undefined);
  const imeBridgeRef = useRef<ImeBridge | undefined>(undefined);
  const [initialData, setInitialData] = useState<SceneSnapshot | undefined>(
    undefined,
  );
  const onSceneChangeRef = useRef(onSceneChange);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onSceneChangeRef.current = onSceneChange;
    onReadyRef.current = onReady;
  }, [onReady, onSceneChange]);

  useEffect(() => {
    let cancelled = false;
    const documentPath =
      useAppStore.getState().tabsById[documentId]?.path ?? undefined;
    void resolveAssetFiles(initialScene.files, documentPath)
      .then((files) => {
        if (!cancelled) {
          setInitialData({ ...initialScene, files });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInitialData(initialScene);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, initialScene]);

  useEffect(
    () => () => {
      imeBridgeRef.current?.dispose();
      adapterRef.current?.dispose();
    },
    [],
  );

  const receiveApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      adapterRef.current?.dispose();
      imeBridgeRef.current?.dispose();

      const adapter = new ExcalidrawAdapter(api, (files) =>
        resolveAssetFiles(
          files,
          useAppStore.getState().tabsById[documentId]?.path ?? undefined,
        ),
      );
      adapterRef.current = adapter;

      if (containerRef.current !== null) {
        imeBridgeRef.current = new ImeBridge(containerRef.current, api);
      }
      if (containerRef.current !== null) {
        onReadyRef.current?.(documentId, adapter, containerRef.current);
      }
    },
    [documentId],
  );

  const handleSceneChange = useCallback(
    (
      elements: SceneSnapshot["elements"],
      appState: SceneSnapshot["appState"],
      files: SceneSnapshot["files"],
    ) => onSceneChangeRef.current({ elements, appState, files }),
    [],
  );

  if (initialData === undefined) {
    return (
      <div
        className="excalidraw-editor"
        data-document-id={documentId}
        ref={containerRef}
      />
    );
  }

  return (
    <div
      className="excalidraw-editor"
      data-document-id={documentId}
      ref={containerRef}
    >
      <Excalidraw
        aiEnabled={false}
        autoFocus
        excalidrawAPI={receiveApi}
        initialData={initialData}
        onChange={handleSceneChange}
        theme={theme}
        validateEmbeddable={false}
        viewModeEnabled={readOnly}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
