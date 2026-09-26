import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedColorScheme } from "../app/theme/types";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import { createReadonlyPreviewInitialData } from "./previewAdapter";

export interface ReadonlyPreviewCanvasProps {
  scene: SceneSnapshot;
  theme: ResolvedColorScheme;
  onRendered?: () => void;
  onError?: (error: unknown) => void;
}

type PreparedPreview = {
  source: SceneSnapshot;
  data: Awaited<ReturnType<typeof createReadonlyPreviewInitialData>>;
};

/**
 * Render a history scene in its own Excalidraw instance. The component does
 * not subscribe to scene changes and deliberately does not expose an editor
 * adapter, save path, or destructive SDK action.
 */
export function ReadonlyPreviewCanvas({
  scene,
  theme,
  onRendered,
  onError,
}: ReadonlyPreviewCanvasProps) {
  const [prepared, setPrepared] = useState<PreparedPreview | null>(null);
  const [preparationError, setPreparationError] = useState<{
    source: SceneSnapshot;
    error: unknown;
  } | null>(null);
  const activeSceneRef = useRef(scene);
  const onRenderedRef = useRef(onRendered);
  const onErrorRef = useRef(onError);
  const [renderedScene, setRenderedScene] = useState<SceneSnapshot | null>(
    null,
  );

  useEffect(() => {
    onRenderedRef.current = onRendered;
    onErrorRef.current = onError;
  }, [onError, onRendered]);

  useEffect(() => {
    activeSceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    let cancelled = false;

    void createReadonlyPreviewInitialData(scene)
      .then((data) => {
        if (cancelled) return;
        setPrepared({ source: scene, data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPrepared(null);
        setPreparationError({ source: scene, error });
        onErrorRef.current?.(error);
      });

    return () => {
      cancelled = true;
    };
  }, [scene]);

  const handleApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      void api;
      const complete = () => {
        if (activeSceneRef.current !== scene) return;
        setRenderedScene(scene);
        onRenderedRef.current?.();
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(complete);
      } else {
        setTimeout(complete, 0);
      }
    },
    [scene],
  );

  const isPreparedForScene = prepared?.source === scene;
  const scenePreparationError =
    preparationError?.source === scene ? preparationError.error : null;
  if (scenePreparationError !== null && !isPreparedForScene) {
    return (
      <p className="history-preview-placeholder" role="alert">
        This version could not be rendered safely.
      </p>
    );
  }
  if (!isPreparedForScene || prepared === null) {
    return (
      <p className="history-preview-placeholder" role="status">
        Preparing version preview…
      </p>
    );
  }

  return (
    <div
      aria-label="Read-only version canvas"
      className="readonly-preview-canvas"
      data-preview-rendered={renderedScene === scene ? "true" : "false"}
      style={{ height: "100%", width: "100%" }}
    >
      <Excalidraw
        aiEnabled={false}
        autoFocus={false}
        excalidrawAPI={handleApiReady}
        initialData={prepared.data}
        theme={theme}
        viewModeEnabled
        handleKeyboardGlobally={false}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveAsImage: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
          tools: { image: false },
        }}
        validateEmbeddable={false}
      />
    </div>
  );
}
