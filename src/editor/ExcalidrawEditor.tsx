import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef } from "react";
import "@excalidraw/excalidraw/index.css";
import type { ResolvedColorScheme } from "../app/theme/types";
import { ExcalidrawAdapter } from "./ExcalidrawAdapter";
import { ImeBridge } from "./imeBridge";
import type { SceneSnapshot } from "./sceneSerializer";

interface ExcalidrawEditorProps {
  documentId: string;
  initialScene: SceneSnapshot;
  theme: ResolvedColorScheme;
  readOnly?: boolean;
  onSceneChange: (scene: SceneSnapshot) => void;
  onReady?: (adapter: ExcalidrawAdapter, container: HTMLDivElement) => void;
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
  const onSceneChangeRef = useRef(onSceneChange);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onSceneChangeRef.current = onSceneChange;
    onReadyRef.current = onReady;
  }, [onReady, onSceneChange]);

  useEffect(
    () => () => {
      imeBridgeRef.current?.dispose();
      adapterRef.current?.dispose();
    },
    [],
  );

  const receiveApi = useCallback((api: ExcalidrawImperativeAPI) => {
    adapterRef.current?.dispose();
    imeBridgeRef.current?.dispose();

    const adapter = new ExcalidrawAdapter(api);
    adapterRef.current = adapter;

    if (containerRef.current !== null) {
      imeBridgeRef.current = new ImeBridge(containerRef.current, api);
    }
    if (containerRef.current !== null) {
      onReadyRef.current?.(adapter, containerRef.current);
    }
  }, []);

  const handleSceneChange = useCallback(
    (
      elements: SceneSnapshot["elements"],
      appState: SceneSnapshot["appState"],
      files: SceneSnapshot["files"],
    ) => onSceneChangeRef.current({ elements, appState, files }),
    [],
  );

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
        initialData={initialScene}
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
