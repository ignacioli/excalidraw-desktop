import type { Page } from "@playwright/test";

const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e",
  elements: [],
  appState: {},
  files: {},
});

/**
 * Browser UI mock for US7: the same `__TAURI_INTERNALS__` invoke mock style as
 * the other browser-ui suites. `convertFileSrc` is emulated so Drawing
 * `.excalidraw_assets` paths resolve in the browser without a native backend.
 */
export async function installUs7Harness(
  page: Page,
  options: {
    files?: readonly string[];
    workspaces?: readonly { id: string; name: string; rootPath: string }[];
  } = {},
): Promise<void> {
  const files = options.files ?? ["drawing.excalidraw", "second.excalidraw"];
  const workspaces = options.workspaces ?? [
    { id: "workspace-1", name: "Workspace", rootPath: "/workspace" },
  ];
  await page.addInitScript(
    ({ fileNames, workspaceSeeds, emptyScene }) => {
      type BrowserWindow = typeof globalThis & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
          convertFileSrc?: (path: string) => string;
        };
        __us7?: {
          state: Us7State;
        };
      };
      interface Us7State {
        files: Map<string, string>;
        storeCalls: string[];
        lookupCalls: string[];
        generateCalls: string[];
        mountedWorkspaces: { id: string; name: string; rootPath: string }[];
        convertCalls: string[];
      }

      const state: Us7State = {
        files: new Map(),
        storeCalls: [],
        lookupCalls: [],
        generateCalls: [],
        mountedWorkspaces: [...workspaceSeeds],
        convertCalls: [],
      };
      const browser = globalThis as BrowserWindow;

      const drawingEntries = (workspaceId: string, rootPath: string) =>
        fileNames.map((name) => ({
          workspaceId,
          kind: "drawing" as const,
          canonicalPath: `${rootPath}/${name}`,
          relativePath: name,
          parentRelativePath: "",
          name,
          displayName: name.replace(/\.excalidraw(\.json)?$/i, ""),
          mtime: 1,
          fileSize: 100,
        }));

      browser.__TAURI_INTERNALS__ = {
        convertFileSrc(path) {
          state.convertCalls.push(path);
          return `asset://${path}`;
        },
        async invoke(command, args = {}) {
          if (command === "plugin:dialog|open") return "/workspace";
          if (command === "plugin:dialog|save") return "/workspace/saved.excalidraw";
          if (command === "app_handshake")
            return {
              contractVersion: 2,
              appVersion: "0.1.0",
              abnormalExit: false,
              pendingOpenPaths: [],
            };
          if (command === "workspace_list") return state.mountedWorkspaces;
          if (command === "workspace_add") {
            const workspace = {
              id: "workspace-2",
              name: "Second Workspace",
              rootPath: "/second-workspace",
              createdAt: 2,
            };
            state.mountedWorkspaces = [...state.mountedWorkspaces, workspace];
            return workspace;
          }
          if (command === "workspace_remove") {
            const workspaceId = String(args.workspaceId ?? "");
            state.mountedWorkspaces = state.mountedWorkspaces.filter(
              (workspace) => workspace.id !== workspaceId,
            );
            return {};
          }
          if (command === "workspace_entry_list") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            if (parentRelativePath !== "") {
              return [];
            }
            const workspace = state.mountedWorkspaces.find(
              (item) => item.id === workspaceId,
            );
            if (workspace === undefined) {
              return [];
            }
            return drawingEntries(workspace.id, workspace.rootPath);
          }
          const path = String(args.path ?? "");
          if (command === "doc_open") {
            const sceneJson = state.files.get(path) ?? emptyScene;
            return {
              scene: JSON.parse(sceneJson),
              baseHash: `base-${path.length}`,
              hasNewerDraft: false,
            };
          }
          if (command === "doc_checkpoint")
            return { newBaseHash: "checkpointed", mtime: 2 };
          if (command === "doc_save_draft")
            return { contentHash: "draft", savedAt: 2 };
          throw new Error(`Unexpected US7 harness command: ${command}`);
        },
      };
      browser.__us7 = { state };
    },
    {
      fileNames: [...files],
      workspaceSeeds: workspaces,
      emptyScene: EMPTY_SCENE,
    },
  );
}

export async function getUs7State(page: Page): Promise<{
  storeCalls: string[];
  lookupCalls: string[];
  generateCalls: string[];
  convertCalls: string[];
  mountedWorkspaces: { id: string; name: string; rootPath: string }[];
}> {
  return page.evaluate(() => {
    const state = (
      globalThis as {
        __us7?: {
          state: {
            storeCalls: string[];
            lookupCalls: string[];
            generateCalls: string[];
            convertCalls: string[];
            mountedWorkspaces: {
              id: string;
              name: string;
              rootPath: string;
            }[];
          };
        };
      }
    ).__us7?.state;
    return {
      storeCalls: state?.storeCalls ?? [],
      lookupCalls: state?.lookupCalls ?? [],
      generateCalls: state?.generateCalls ?? [],
      convertCalls: state?.convertCalls ?? [],
      mountedWorkspaces: state?.mountedWorkspaces ?? [],
    };
  });
}
