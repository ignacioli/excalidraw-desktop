import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LOCAL_VERSION_HISTORY_FIXTURES,
  cloneLocalVersionHistoryFixture,
  getLocalVersionHistoryFixture,
  imageBytesFromDataUrl,
  serializeHistoryScene,
  type LocalVersionHistoryFixture,
} from "./local-version-history";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertFixtureHashes(fixture: LocalVersionHistoryFixture): void {
  const expected = fixture.expectedHashes;
  const persistedJson = serializeHistoryScene(fixture.persistedScene);
  const currentJson = serializeHistoryScene(fixture.currentScene);

  expect(sha256(persistedJson)).toBe(expected.persistedSceneSha256);
  expect(sha256(currentJson)).toBe(expected.currentSceneSha256);
  expect(sha256(persistedJson)).toBe(expected.documentSha256);

  for (const [fileId, image] of Object.entries(fixture.persistedScene.files)) {
    expect(expected.imageSha256[fileId]).toBeDefined();
    expect(sha256(imageBytesFromDataUrl(image.dataURL))).toBe(
      expected.imageSha256[fileId],
    );
    if (fixture.imageIntegrity === "valid") {
      expect(image.declaredSha256).toBe(expected.imageSha256[fileId]);
    } else {
      expect(image.declaredSha256).not.toBe(expected.imageSha256[fileId]);
    }
  }
}

describe("local version history fixtures", () => {
  it("declares all required isolated document variants", () => {
    expect(LOCAL_VERSION_HISTORY_FIXTURES.map(({ id }) => id)).toEqual([
      "text",
      "shape",
      "image",
      "unsaved-edit",
      "corrupt-image",
    ]);

    const documentIds = new Set(
      LOCAL_VERSION_HISTORY_FIXTURES.map(
        ({ identity: { documentId } }) => documentId,
      ),
    );
    const historyRoots = new Set(
      LOCAL_VERSION_HISTORY_FIXTURES.map(
        ({ identity: { historyRoot } }) => historyRoot,
      ),
    );
    expect(documentIds.size).toBe(LOCAL_VERSION_HISTORY_FIXTURES.length);
    expect(historyRoots.size).toBe(LOCAL_VERSION_HISTORY_FIXTURES.length);
  });

  it("keeps every persisted/current scene and image baseline deterministic", () => {
    for (const fixture of LOCAL_VERSION_HISTORY_FIXTURES) {
      expect(() => assertFixtureHashes(fixture)).not.toThrow();
      expect(fixture.identity.canonicalPath).toContain(
        `/local-version-history/${fixture.id}/`,
      );
      expect(fixture.identity.historyRoot).toContain(
        `/local-version-history/${fixture.id}/`,
      );
    }
  });

  it("represents unsaved edits without changing the persisted document hash", () => {
    const fixture = getLocalVersionHistoryFixture("unsaved-edit");
    expect(fixture.saveState).toBe("dirty");
    expect(fixture.persistedScene.elements).toHaveLength(1);
    expect(fixture.currentScene.elements).toHaveLength(2);
    expect(fixture.expectedHashes.persistedSceneSha256).not.toBe(
      fixture.expectedHashes.currentSceneSha256,
    );
    expect(fixture.expectedHashes.documentSha256).toBe(
      fixture.expectedHashes.persistedSceneSha256,
    );
  });

  it("marks a corrupt image by declared-versus-actual hash mismatch", () => {
    const fixture = getLocalVersionHistoryFixture("corrupt-image");
    const image = fixture.persistedScene.files["corrupt-image-pixel"];
    expect(image).toBeDefined();
    if (image === undefined) {
      throw new Error("Corrupt image fixture did not declare its image file.");
    }
    expect(fixture.imageIntegrity).toBe("corrupt");
    expect(sha256(imageBytesFromDataUrl(image.dataURL))).toBe(
      fixture.expectedHashes.imageSha256[image.id],
    );
    expect(image.declaredSha256).not.toBe(
      fixture.expectedHashes.imageSha256[image.id],
    );
  });

  it("returns an isolated clone without mutating the shared baseline", () => {
    const clone = cloneLocalVersionHistoryFixture(
      getLocalVersionHistoryFixture("text"),
    );
    const mutatedClone: LocalVersionHistoryFixture = {
      ...clone,
      currentScene: {
        ...clone.currentScene,
        elements: clone.currentScene.elements.map((element, index) =>
          index === 0 ? { ...element, text: "mutated clone" } : element,
        ),
      },
    };

    expect(mutatedClone.currentScene.elements[0]?.text).toBe("mutated clone");
    expect(
      getLocalVersionHistoryFixture("text").currentScene.elements[0]?.text,
    ).toBe("历史中的文字");
  });
});
