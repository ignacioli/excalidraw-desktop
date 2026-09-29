import { exportToSvg } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { useEffect, useRef, useState } from "react";
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

type RenderedPreview = {
  source: SceneSnapshot;
  url: string;
};

/**
 * Render a history scene as a static SVG using Excalidraw's public export API.
 * It deliberately does not mount a second interactive SDK editor, which
 * would also bring its own MainMenu into the narrow history drawer.
 */
export function ReadonlyPreviewCanvas({
  scene,
  theme,
  onRendered,
  onError,
}: ReadonlyPreviewCanvasProps) {
  const [prepared, setPrepared] = useState<PreparedPreview | null>(null);
  const [renderError, setRenderError] = useState<{
    source: SceneSnapshot;
    error: unknown;
  } | null>(null);
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const [renderedScene, setRenderedScene] = useState<SceneSnapshot | null>(
    null,
  );
  const activeSceneRef = useRef(scene);
  const onRenderedRef = useRef(onRendered);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    activeSceneRef.current = scene;
    onRenderedRef.current = onRendered;
    onErrorRef.current = onError;
  }, [onError, onRendered, scene]);

  useEffect(() => {
    let cancelled = false;

    void createReadonlyPreviewInitialData(scene)
      .then((data) => {
        if (cancelled) return;
        setRenderError(null);
        setPrepared({ source: scene, data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setRenderError({ source: scene, error });
        onErrorRef.current?.(error);
      });

    return () => {
      cancelled = true;
    };
  }, [scene]);

  useEffect(() => {
    if (prepared?.source !== scene) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    void exportToSvg({
      elements: prepared.data.elements.filter(isNonDeletedElement),
      appState: { ...prepared.data.appState, theme },
      files: prepared.data.files,
      renderEmbeddables: false,
      exportPadding: 0,
    })
      .then((svg: SVGSVGElement) => {
        if (cancelled || activeSceneRef.current !== scene) return;
        objectUrl = URL.createObjectURL(
          new Blob([svg.outerHTML], { type: "image/svg+xml;charset=utf-8" }),
        );
        setPreview({ source: scene, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled || activeSceneRef.current !== scene) return;
        setPreview(null);
        setRenderError({ source: scene, error });
        onErrorRef.current?.(error);
      });

    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [prepared, scene, theme]);

  const sceneRenderError =
    renderError?.source === scene ? renderError.error : null;
  const isPreparedForScene = prepared?.source === scene;
  const previewUrl = preview?.source === scene ? preview.url : null;

  if (sceneRenderError !== null) {
    return (
      <p className="history-preview-placeholder" role="alert">
        This version could not be rendered safely.
      </p>
    );
  }
  if (!isPreparedForScene || previewUrl === null) {
    return (
      <p className="history-preview-placeholder" role="status">
        Preparing version preview…
      </p>
    );
  }

  return (
    <div
      className="readonly-preview-canvas"
      data-preview-rendered={renderedScene === scene ? "true" : "false"}
      style={{ height: "100%", width: "100%" }}
    >
      <img
        alt="Read-only version canvas"
        onError={() => {
          if (activeSceneRef.current !== scene || preview?.source !== scene) {
            return;
          }
          const error = new Error("The static version preview could not load.");
          URL.revokeObjectURL(previewUrl);
          setPreview(null);
          setRenderError({ source: scene, error });
          onErrorRef.current?.(error);
        }}
        onLoad={() => {
          if (activeSceneRef.current !== scene || preview?.source !== scene) {
            return;
          }
          setRenderedScene(scene);
          onRenderedRef.current?.();
        }}
        src={previewUrl}
      />
    </div>
  );
}

function isNonDeletedElement(
  element: ExcalidrawElement,
): element is NonDeletedExcalidrawElement {
  return !element.isDeleted;
}
