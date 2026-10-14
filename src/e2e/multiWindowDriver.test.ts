import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import type {
  DocumentSession,
  DocumentStoreState,
} from "../documents/documentStore";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import {
  MultiWindowDriver,
  type DriverControl,
  type DriverRequest,
} from "./multiWindowDriver";

// The driver module also creates the app's own driver; keep the editor out.
vi.mock("../documents/documentStore", () => ({ documentManager: {} }));

function scene(x: number): SceneSnapshot {
  return {
    elements: [{ id: "rect", x, y: 0, isDeleted: false }],
    appState: {},
    files: {},
  } as unknown as SceneSnapshot;
}

function session(
  id: string,
  path: string,
  overrides: Partial<DocumentSession> = {},
): DocumentSession {
  return {
    id,
    path,
    title: path,
    scene: scene(0),
    sceneVersion: 0,
    revision: 0,
    baseHash: "base",
    saveState: "clean",
    errorMessage: null,
    conflictInfo: null,
    lastReloadedAt: null,
    ...overrides,
  };
}

function setup(sessions: DocumentSession[] = []) {
  const store = createStore<DocumentStoreState>(
    () =>
      ({
        sessionsById: Object.fromEntries(sessions.map((s) => [s.id, s])),
        tabOrder: sessions.map((s) => s.id),
        activeDocumentId: sessions[0]?.id ?? null,
      }) as unknown as DocumentStoreState,
  );
  const openRouted = vi.fn(
    async (path: string): Promise<string | null> =>
      Object.values(store.getState().sessionsById).find(
        (candidate) => candidate.path === path,
      )?.id ?? null,
  );
  const root = document.createElement("div");
  const driver = new MultiWindowDriver({
    control: {
      bootstrap: async () => true,
      next: async () => null,
      publish: async () => undefined,
    },
    documents: { store, openRouted },
    root,
    wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
    timeoutMs: 200,
  });
  return { driver, store, openRouted, root };
}

function request(action: string, args?: Record<string, unknown>) {
  return { id: `req-${action}`, action, args };
}

describe("MultiWindowDriver", () => {
  it("opens a folder through the shell and a drawing through the router", async () => {
    const { driver, openRouted } = setup([session("doc-a", "/w/a.excalidraw")]);
    const openWorkspace = vi.fn(async () => undefined);
    driver.attachShell({ openWorkspace });

    expect(
      await driver.answer(request("openWorkspace", { rootPath: "/w" })),
    ).toEqual({ id: "req-openWorkspace", ok: true, result: {} });
    expect(
      await driver.answer(request("openDrawing", { path: "/w/a.excalidraw" })),
    ).toEqual({
      id: "req-openDrawing",
      ok: true,
      result: { documentId: "doc-a" },
    });
    expect(openWorkspace).toHaveBeenCalledWith("/w");
    expect(openRouted).toHaveBeenCalledWith("/w/a.excalidraw");
  });

  it("answers an edit once the draft of the edit is stored", async () => {
    const { driver, store } = setup([session("doc-a", "/w/a.excalidraw")]);
    const editor = {
      isEditable: () => true,
      applyPerformanceEdit: vi.fn(() => {
        const current = store.getState().sessionsById["doc-a"];
        store.setState({
          sessionsById: {
            "doc-a": { ...current, revision: 1, saveState: "savingDraft" },
          },
        });
        setTimeout(() =>
          store.setState({
            sessionsById: {
              "doc-a": {
                ...current,
                revision: 1,
                saveState: "draftSaved",
                scene: scene(1),
              },
            },
          }),
        );
        return true;
      }),
    };
    driver.attachEditor("doc-a", editor);

    const answer = await driver.answer(
      request("edit", { path: "/w/a.excalidraw", seed: 7 }),
    );

    expect(answer).toEqual({
      id: "req-edit",
      ok: true,
      result: { documentId: "doc-a", elements: [{ id: "rect", x: 1, y: 0 }] },
    });
    expect(editor.applyPerformanceEdit).toHaveBeenCalledWith(7, 0);
  });

  it("fails an edit whose draft is never stored", async () => {
    const { driver } = setup([session("doc-a", "/w/a.excalidraw")]);
    driver.attachEditor("doc-a", {
      isEditable: () => true,
      applyPerformanceEdit: () => true,
    });

    const answer = await driver.answer(
      request("edit", { path: "/w/a.excalidraw" }),
    );

    expect(answer).toEqual({
      id: "req-edit",
      ok: false,
      error: "Timed out waiting for the draft of the edit.",
    });
  });

  it("reports tabs in order, the active tab, Recovery candidates, and errors", async () => {
    const { driver, root } = setup([
      session("doc-a", "/w/a.excalidraw", { saveState: "dirty" }),
      session("doc-b", "/w/b.excalidraw"),
    ]);
    root.innerHTML = `
      <ul><li class="recovery-candidate"><p class="recovery-candidate-path">/w/a.excalidraw</p></li></ul>
      <p role="alert">Excalidraw didn’t quit.</p><p role="alert"></p>
      <p role="status" class="save-status save-status--error">A drawing could not be saved.</p>`;

    const answer = await driver.answer(request("report"));

    expect(answer.result).toEqual({
      tabs: [
        {
          path: "/w/a.excalidraw",
          saveState: "dirty",
          elements: [{ id: "rect", x: 0, y: 0 }],
        },
        {
          path: "/w/b.excalidraw",
          saveState: "clean",
          elements: [{ id: "rect", x: 0, y: 0 }],
        },
      ],
      activePath: "/w/a.excalidraw",
      welcome: false,
      recoveryCandidates: ["/w/a.excalidraw"],
      alerts: ["Excalidraw didn’t quit.", "A drawing could not be saved."],
    });
  });

  it("restores each Recovery candidate with its own Restore button", async () => {
    const { driver, root } = setup();
    root.innerHTML = ["/w/a.excalidraw", "/w/b.excalidraw"]
      .map(
        (path) => `<div class="recovery-candidate">
          <p class="recovery-candidate-path">${path}</p>
          <div class="recovery-candidate-actions"><button>Restore</button><button>Discard</button></div>
        </div>`,
      )
      .join("");
    const clicked: string[] = [];
    root.addEventListener("click", (event) => {
      const candidate = (event.target as HTMLElement).closest(
        ".recovery-candidate",
      );
      clicked.push((event.target as HTMLElement).textContent ?? "");
      setTimeout(() => candidate?.remove());
    });

    const answer = await driver.answer(request("recover"));

    expect(answer.result).toEqual({
      restored: ["/w/a.excalidraw", "/w/b.excalidraw"],
    });
    expect(clicked).toEqual(["Restore", "Restore"]);
  });

  it("answers an unknown request with an error", async () => {
    const { driver } = setup();

    expect(await driver.answer(request("teleport"))).toEqual({
      id: "req-teleport",
      ok: false,
      error: "Unknown window request teleport.",
    });
  });

  it("serves queued requests in order and nothing when the flag is off", async () => {
    const queue: DriverRequest[] = [request("report"), request("teleport")];
    const published: string[] = [];
    const control: DriverControl = {
      bootstrap: async () => true,
      next: async () => queue.shift() ?? null,
      publish: async (answer) => {
        published.push(`${answer.id}:${answer.ok}`);
      },
    };
    const { store, openRouted, root } = setup();
    const serving = new MultiWindowDriver({
      control,
      documents: { store, openRouted },
      root,
      wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    serving.start();
    await vi.waitFor(() =>
      expect(published).toEqual(["req-report:true", "req-teleport:false"]),
    );
    serving.stop();

    const next = vi.fn(async () => null);
    new MultiWindowDriver({
      control: { ...control, bootstrap: async () => false, next },
      documents: { store, openRouted },
      root,
      wait: async () => undefined,
    }).start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next).not.toHaveBeenCalled();
  });
});
