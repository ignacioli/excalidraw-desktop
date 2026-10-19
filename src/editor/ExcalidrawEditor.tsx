import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@excalidraw/excalidraw/index.css";
import type { ModePreference, ResolvedColorScheme } from "../app/theme/types";
import { documentManager } from "../documents/documentStore";
import { useI18n } from "../i18n";
import type { LanguagePreference } from "../i18n/resolveLanguage";
import {
  CanvasMainMenu,
  type EditorPreference,
  type EditorPreferences,
} from "./CanvasMainMenu";
import { ExcalidrawAdapter, type CanvasPreferences } from "./ExcalidrawAdapter";
import { resolveAssetFiles } from "./assetResolver";
import { ImeBridge } from "./imeBridge";
import type { SceneSnapshot } from "./sceneSerializer";
import type { ProtectedInputHandlers } from "../history/protectedInput";

/** Per-editor entry points shared by the canvas menu and the native menu. */
export interface EditorControls {
  togglePreference(preference: EditorPreference): void;
  openHelp(): void;
}

const NO_PREFERENCES: EditorPreferences = {
  toolLock: false,
  grid: false,
  snap: false,
  zen: false,
  viewMode: false,
};

function samePreferences(a: EditorPreferences, b: EditorPreferences): boolean {
  return (
    a.toolLock === b.toolLock &&
    a.grid === b.grid &&
    a.snap === b.snap &&
    a.zen === b.zen &&
    a.viewMode === b.viewMode
  );
}

interface ExcalidrawEditorProps {
  documentId: string;
  initialScene: SceneSnapshot;
  theme: ResolvedColorScheme;
  /** The stored appearance preference shown by the canvas Theme item. */
  appearance?: ModePreference;
  /** Forced read-only (conflict or history work); overrides user View mode. */
  readOnly?: boolean;
  onSceneChange: (scene: SceneSnapshot) => void;
  onAppearanceChange?: (mode: ModePreference) => void;
  onLanguageChange?: (preference: LanguagePreference) => void;
  onPreferencesChange?: (
    documentId: string,
    preferences: EditorPreferences,
  ) => void;
  onControlsReady?: (documentId: string, controls: EditorControls) => void;
  /** Host-owned handlers for destructive clear/import entry points. */
  protectedInput?: ProtectedInputHandlers;
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
  appearance = "system",
  readOnly = false,
  onSceneChange,
  onAppearanceChange,
  onLanguageChange,
  onPreferencesChange,
  onControlsReady,
  protectedInput,
  onReady,
}: ExcalidrawEditorProps) {
  const { resolvedLanguage } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<ExcalidrawAdapter | undefined>(undefined);
  const imeBridgeRef = useRef<ImeBridge | undefined>(undefined);
  const protectedInputRef = useRef(protectedInput);
  const [initialData, setInitialData] = useState<SceneSnapshot | undefined>(
    undefined,
  );
  const onSceneChangeRef = useRef(onSceneChange);
  const onReadyRef = useRef(onReady);
  const onAppearanceChangeRef = useRef(onAppearanceChange);
  const onLanguageChangeRef = useRef(onLanguageChange);
  const onPreferencesChangeRef = useRef(onPreferencesChange);
  const onControlsReadyRef = useRef(onControlsReady);
  const [userViewMode, setUserViewMode] = useState(false);
  const [canvasPreferences, setCanvasPreferences] =
    useState<CanvasPreferences>(NO_PREFERENCES);
  const viewModeEnabled = readOnly || userViewMode;
  const preferences = useMemo<EditorPreferences>(
    () => ({ ...canvasPreferences, viewMode: viewModeEnabled }),
    [canvasPreferences, viewModeEnabled],
  );
  const readOnlyRef = useRef(readOnly);
  const themeRef = useRef(theme);
  const sdkThemeRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    onSceneChangeRef.current = onSceneChange;
    protectedInputRef.current = protectedInput;
    onReadyRef.current = onReady;
    onAppearanceChangeRef.current = onAppearanceChange;
    onLanguageChangeRef.current = onLanguageChange;
    onPreferencesChangeRef.current = onPreferencesChange;
    onControlsReadyRef.current = onControlsReady;
  }, [
    onAppearanceChange,
    onControlsReady,
    onLanguageChange,
    onPreferencesChange,
    onReady,
    onSceneChange,
    protectedInput,
  ]);

  // Layout effects run before the SDK reports a prop-driven theme change.
  useLayoutEffect(() => {
    themeRef.current = theme;
    readOnlyRef.current = readOnly;
  }, [readOnly, theme]);

  const reportedPreferencesRef = useRef<EditorPreferences | undefined>(
    undefined,
  );
  useEffect(() => {
    const reported = reportedPreferencesRef.current;
    if (reported !== undefined && samePreferences(reported, preferences)) {
      return;
    }
    reportedPreferencesRef.current = preferences;
    onPreferencesChangeRef.current?.(documentId, preferences);
  });

  const togglePreference = useCallback((preference: EditorPreference) => {
    if (
      readOnlyRef.current &&
      (preference === "toolLock" ||
        preference === "snap" ||
        preference === "viewMode")
    ) {
      return;
    }
    if (preference === "viewMode") {
      setUserViewMode((enabled) => !enabled);
      return;
    }
    adapterRef.current?.togglePreference(preference);
  }, []);

  const changeLanguage = useCallback((preference: LanguagePreference) => {
    onLanguageChangeRef.current?.(preference);
    adapterRef.current?.closeMainMenu();
  }, []);
  const changeAppearance = useCallback((mode: ModePreference) => {
    onAppearanceChangeRef.current?.(mode);
  }, []);

  // A new children element re-renders the SDK, which then reports its
  // current scene through onChange. Keep the menu element stable so host
  // re-renders (e.g. a disk reload in flight) do not emit a stale scene.
  const mainMenu = useMemo(
    () => (
      <CanvasMainMenu
        appearance={appearance}
        forcedReadOnly={readOnly}
        onAppearanceChange={changeAppearance}
        onLanguageChange={changeLanguage}
        onTogglePreference={togglePreference}
        preferences={preferences}
      />
    ),
    [
      appearance,
      changeAppearance,
      changeLanguage,
      preferences,
      readOnly,
      togglePreference,
    ],
  );

  // Option+R toggles the user's View mode. The SDK leaves its own shortcut
  // off because viewModeEnabled is controlled. Focus often rests on <body>
  // (e.g. in View mode), so listen on the document and act only for the
  // visible editor when focus is on the page or inside this editor.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const container = containerRef.current;
      if (
        container === null ||
        event.code !== "KeyR" ||
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        container.closest("[hidden]") !== null
      ) {
        return;
      }
      const target = event.target;
      if (
        target !== document.body &&
        !(target instanceof Node && container.contains(target))
      ) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      event.preventDefault();
      togglePreference("viewMode");
    };
    // Capture phase: the SDK stops this key's propagation in View mode.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [togglePreference]);

  // "?" opens the SDK help dialog. The SDK only listens on its own container,
  // so focus resting on <body> or the sidebar would lose the shortcut. Mirror
  // the SDK's handling on the document and leave "?" inside the editor, an
  // input, or an open dialog/menu to its owner.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const container = containerRef.current;
      if (
        container === null ||
        event.key !== "?" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        container.closest("[hidden]") !== null
      ) {
        return;
      }
      const target = event.target;
      // The SDK's container handler owns "?" while focus is inside the editor;
      // its help dialog is portaled to <body>, so open dialogs are excluded
      // below instead.
      if (target instanceof Node && container.contains(target)) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.closest(
            '[role="dialog"], [aria-modal="true"], [role="menu"]',
          ) !== null)
      ) {
        return;
      }
      event.preventDefault();
      adapterRef.current?.openHelp();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const documentPath =
      documentManager.store.getState().sessionsById[documentId]?.path;
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
          documentManager.store.getState().sessionsById[documentId]?.path,
        ),
      );
      adapterRef.current = adapter;

      if (containerRef.current !== null) {
        imeBridgeRef.current = new ImeBridge(containerRef.current, api);
        const removeProtectedInput = adapter.installProtectedInput(
          containerRef.current,
          {
            get onClear() {
              return protectedInputRef.current?.onClear;
            },
            get onImportShortcut() {
              return protectedInputRef.current?.onImportShortcut;
            },
            get onSceneDrop() {
              return protectedInputRef.current?.onSceneDrop;
            },
            onError: (error) => protectedInputRef.current?.onError?.(error),
          },
        );
        const observer = new ResizeObserver(() => {
          adapter.refresh();
        });
        observer.observe(containerRef.current);
        const previousDispose = adapter.dispose.bind(adapter);
        adapter.dispose = () => {
          observer.disconnect();
          removeProtectedInput();
          previousDispose();
        };
      }
      if (containerRef.current !== null) {
        onReadyRef.current?.(documentId, adapter, containerRef.current);
      }
      onControlsReadyRef.current?.(documentId, {
        togglePreference,
        openHelp: () => adapter.openHelp(),
      });
    },
    [documentId, togglePreference],
  );

  const handleSceneChange = useCallback(
    (
      elements: SceneSnapshot["elements"],
      appState: AppState,
      files: SceneSnapshot["files"],
    ) => {
      onSceneChangeRef.current({ elements, appState, files });

      const next = {
        toolLock: appState.activeTool.locked,
        grid: appState.gridModeEnabled,
        snap: appState.objectsSnapModeEnabled,
        zen: appState.zenModeEnabled,
      };
      setCanvasPreferences((current) =>
        current.toolLock === next.toolLock &&
        current.grid === next.grid &&
        current.snap === next.snap &&
        current.zen === next.zen
          ? current
          : next,
      );

      // Only an SDK-originated change (Shift+Option+D) differs from the prop.
      if (appState.theme !== sdkThemeRef.current) {
        sdkThemeRef.current = appState.theme;
        if (appState.theme !== themeRef.current) {
          onAppearanceChangeRef.current?.(appState.theme);
        }
      }
    },
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
        langCode={resolvedLanguage}
        onChange={handleSceneChange}
        theme={theme}
        validateEmbeddable={false}
        viewModeEnabled={viewModeEnabled}
        UIOptions={{
          canvasActions: {
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: true,
          },
        }}
      >
        {mainMenu}
      </Excalidraw>
    </div>
  );
}
