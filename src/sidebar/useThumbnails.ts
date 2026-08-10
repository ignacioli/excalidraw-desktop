import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInvoker } from "../ipc/client";
import type { ColorScheme } from "../ipc/contracts";
import {
  createThumbnailRenderer,
  type ThumbnailRenderResult,
  type ThumbnailRenderer,
} from "./thumbnailRenderer";
import { ThumbnailCancelledError, ThumbnailQueue } from "./thumbnailQueue";

export interface ThumbnailRowState {
  phase: "idle" | "loading" | "ready" | "error";
  webpPath?: string;
}

export interface UseThumbnailsOptions {
  invoker: CommandInvoker;
  theme: ColorScheme;
  /** Only request thumbnails when a native Tauri command runtime exists. */
  enabled: boolean;
  /** Canonical paths of the file rows currently in the visible range. */
  visiblePaths: readonly string[];
}

interface ActiveJob {
  jobId: string;
  theme: ColorScheme;
  cancel: () => void;
}

function isRenderResult(value: unknown): value is ThumbnailRenderResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "key" in value &&
    typeof value.key === "string" &&
    "webpBytes" in value &&
    Array.isArray(value.webpBytes)
  );
}

/**
 * Lazily materializes thumbnails for visible file rows: `thumb_lookup` first,
 * then `doc_open` + worker/main-thread render + `thumb_store` on a miss, and
 * renders hits through the asset protocol. Jobs for rows that scroll out of
 * view are cancelled and retried when they become visible again.
 */
export function useThumbnails({
  invoker,
  theme,
  enabled,
  visiblePaths,
}: UseThumbnailsOptions): ReadonlyMap<string, ThumbnailRowState> {
  const [states, setStates] = useState<ReadonlyMap<string, ThumbnailRowState>>(
    () => new Map(),
  );
  const requestMetaRef = useRef<Map<string, { theme: ColorScheme }>>(new Map());
  const inflightRef = useRef<Map<string, ColorScheme>>(new Map());
  const jobsRef = useRef<Map<string, ActiveJob>>(new Map());
  const queueRef = useRef<ThumbnailQueue | undefined>(undefined);
  if (queueRef.current === undefined) {
    queueRef.current = new ThumbnailQueue({ concurrency: 1 });
  }
  const rendererRef = useRef<ThumbnailRenderer | undefined>(undefined);
  if (rendererRef.current === undefined) {
    rendererRef.current = createThumbnailRenderer();
  }

  const setPhase = useCallback((path: string, state: ThumbnailRowState) => {
    setStates((current) => {
      const next = new Map(current);
      next.set(path, state);
      return next;
    });
  }, []);

  const requestThumbnail = useCallback(
    async (path: string) => {
      const requestTheme = theme;
      inflightRef.current.set(path, requestTheme);
      requestMetaRef.current.set(path, { theme: requestTheme });
      setPhase(path, { phase: "loading" });
      const superseded = () =>
        requestMetaRef.current.get(path)?.theme !== requestTheme;
      const abandonIfSuperseded = () => {
        if (superseded() && !inflightRef.current.has(path)) {
          setPhase(path, { phase: "idle" });
        }
      };

      try {
        const lookup = await invoker.invoke("thumb_lookup", { path, theme });
        if (superseded()) {
          abandonIfSuperseded();
          return;
        }
        if (lookup.hit && lookup.webpPath !== undefined) {
          setPhase(path, {
            phase: "ready",
            webpPath: convertFileSrc(lookup.webpPath),
          });
          return;
        }

        const opened = await invoker.invoke("doc_open", { path });
        if (superseded()) {
          abandonIfSuperseded();
          return;
        }
        const sceneJson = JSON.stringify(opened.scene);
        const renderer = rendererRef.current;
        const queue = queueRef.current;
        if (renderer === undefined || queue === undefined) {
          setPhase(path, { phase: "error" });
          return;
        }
        const jobId = `${path}|${requestTheme}`;
        const job = queue.enqueue({
          id: jobId,
          run: () => renderer.render(sceneJson, requestTheme),
        });
        const active: ActiveJob = {
          jobId,
          theme: requestTheme,
          cancel: () => queue.cancel(jobId),
        };
        jobsRef.current.set(path, active);

        try {
          const result = await job;
          if (superseded()) {
            abandonIfSuperseded();
            return;
          }
          if (result === null || !isRenderResult(result)) {
            setPhase(path, { phase: "error" });
            return;
          }
          const stored = await invoker.invoke("thumb_store", {
            path,
            theme,
            key: result.key,
            webpBytes: result.webpBytes,
          });
          if (superseded()) {
            abandonIfSuperseded();
            return;
          }
          setPhase(path, {
            phase: "ready",
            webpPath: convertFileSrc(stored.webpPath),
          });
        } catch (error) {
          if (superseded()) {
            abandonIfSuperseded();
            return;
          }
          setPhase(
            path,
            error instanceof ThumbnailCancelledError
              ? { phase: "idle" }
              : { phase: "error" },
          );
        } finally {
          if (jobsRef.current.get(path)?.jobId === jobId) {
            jobsRef.current.delete(path);
          }
        }
      } catch (error) {
        if (superseded()) {
          abandonIfSuperseded();
          return;
        }
        setPhase(
          path,
          error instanceof ThumbnailCancelledError
            ? { phase: "idle" }
            : { phase: "error" },
        );
      } finally {
        if (inflightRef.current.get(path) === requestTheme) {
          inflightRef.current.delete(path);
        }
      }
    },
    [invoker, setPhase, theme],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const visible = new Set(visiblePaths);
    for (const [path, active] of jobsRef.current) {
      if (!visible.has(path) || active.theme !== theme) {
        active.cancel();
        jobsRef.current.delete(path);
      }
    }
    for (const path of visiblePaths) {
      if (inflightRef.current.has(path)) {
        continue;
      }
      const meta = requestMetaRef.current.get(path);
      const current = states.get(path);
      if (meta?.theme === theme && current?.phase !== "idle") {
        continue;
      }
      void requestThumbnail(path);
    }
  }, [enabled, requestThumbnail, states, theme, visiblePaths]);

  useEffect(
    () => () => {
      for (const active of jobsRef.current.values()) {
        active.cancel();
      }
      jobsRef.current.clear();
      queueRef.current?.cancelAll();
      rendererRef.current?.dispose();
    },
    [],
  );

  return states;
}
