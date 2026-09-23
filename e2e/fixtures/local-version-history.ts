/**
 * Deterministic, isolated document fixtures for local version history tests.
 *
 * These fixtures are data-only. They do not create files, touch the filesystem,
 * or claim that a browser run proves native persistence. Every fixture has its
 * own document identity and history root so a scenario can be run from a
 * fresh state without inheriting another scenario's records.
 */

export type LocalVersionHistoryFixtureId =
  | "text"
  | "shape"
  | "image"
  | "unsaved-edit"
  | "corrupt-image";

export type HistoryElementType = "text" | "rectangle" | "diamond" | "image";
export type HistorySaveState = "clean" | "dirty";
export type HistoryImageIntegrity = "valid" | "corrupt";

export interface HistoryElement {
  readonly id: string;
  readonly type: HistoryElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: "solid";
  readonly strokeWidth: number;
  readonly roughness: number;
  readonly opacity: number;
  readonly groupIds: readonly string[] | null;
  readonly frameId: string | null;
  readonly index: string;
  readonly roundness: Readonly<Record<string, unknown>> | null;
  readonly boundElements: readonly unknown[] | null;
  readonly updated: number;
  readonly seed: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly locked: boolean;
  readonly link: string | null;
  readonly customData: Readonly<Record<string, unknown>> | null;
  readonly text?: string;
  readonly originalText?: string;
  readonly fontSize?: number;
  readonly fontFamily?: number;
  readonly textAlign?: "left" | "center" | "right";
  readonly verticalAlign?: "top" | "middle" | "bottom";
  readonly baseline?: number;
  readonly containerId?: string | null;
  readonly points?: readonly (readonly [number, number])[];
  readonly fileId?: string;
  readonly status?: "saved";
}

export interface HistoryImageFile {
  readonly id: string;
  readonly mimeType: "image/png";
  readonly dataURL: string;
  readonly created: number;
  readonly lastRetrieved: number;
  readonly status: "saved";
  readonly isAnimated: boolean;
  readonly integrity: HistoryImageIntegrity;
  /** The hash stored by the fixture as the expected content-addressed hash. */
  readonly declaredSha256: string;
}

export interface HistoryScene {
  readonly type: "excalidraw";
  readonly version: 2;
  readonly source: "local-version-history-fixture";
  readonly elements: readonly HistoryElement[];
  readonly appState: Readonly<{
    readonly viewBackgroundColor: string;
    readonly gridSize: null;
    readonly zenModeEnabled: false;
    readonly viewModeEnabled: false;
  }>;
  readonly files: Readonly<Record<string, HistoryImageFile>>;
}

export interface HistoryDocumentIdentity {
  readonly workspaceId: string;
  readonly documentId: string;
  readonly canonicalPath: string;
  readonly historyRoot: string;
}

export interface HistoryFixtureExpectedHashes {
  /** SHA-256 of the canonical persisted scene JSON. */
  readonly persistedSceneSha256: string;
  /** SHA-256 of the canonical current scene JSON; differs for unsaved edits. */
  readonly currentSceneSha256: string;
  /** SHA-256 of the bytes written to the .excalidraw document. */
  readonly documentSha256: string;
  /** SHA-256 of each image's decoded data URL bytes. */
  readonly imageSha256: Readonly<Record<string, string>>;
}

export interface LocalVersionHistoryFixture {
  readonly id: LocalVersionHistoryFixtureId;
  readonly label: string;
  readonly identity: HistoryDocumentIdentity;
  readonly saveState: HistorySaveState;
  readonly imageIntegrity: HistoryImageIntegrity;
  readonly persistedScene: HistoryScene;
  readonly currentScene: HistoryScene;
  readonly expectedHashes: HistoryFixtureExpectedHashes;
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3OQAAAAASUVORK5CYII=";
const CORRUPT_PNG_DATA_URL =
  "data:image/png;base64,Y29ycnVwdC1pbWFnZS1ieXRlcw==";

const BASE_ELEMENT = {
  x: 120,
  y: 96,
  angle: 0,
  strokeColor: "#1b1b1f",
  backgroundColor: "transparent",
  fillStyle: "solid" as const,
  strokeWidth: 2,
  roughness: 0,
  opacity: 100,
  groupIds: null,
  frameId: null,
  index: "a0",
  roundness: null,
  boundElements: null,
  updated: 1_758_000_000_000,
  seed: 101,
  version: 1,
  versionNonce: 201,
  isDeleted: false,
  locked: false,
  link: null,
  customData: null,
};

function textElement(
  id: string,
  text: string,
  seed: number,
): HistoryElement {
  return {
    ...BASE_ELEMENT,
    id,
    type: "text",
    width: 280,
    height: 32,
    seed,
    versionNonce: seed + 100,
    text,
    originalText: text,
    fontSize: 24,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "middle",
    baseline: 24,
  };
}

function shapeElement(
  id: string,
  type: "rectangle" | "diamond",
  seed: number,
): HistoryElement {
  return {
    ...BASE_ELEMENT,
    id,
    type,
    width: 220,
    height: 140,
    backgroundColor: "#c8f7dc",
    seed,
    versionNonce: seed + 100,
    points: [
      [0, 0],
      [220, 0],
      [220, 140],
      [0, 140],
    ],
  };
}

function imageElement(id: string, fileId: string, seed: number): HistoryElement {
  return {
    ...BASE_ELEMENT,
    id,
    type: "image",
    width: 64,
    height: 64,
    backgroundColor: "#f6f6f6",
    seed,
    versionNonce: seed + 100,
    fileId,
    status: "saved",
  };
}

function imageFile(
  fileId: string,
  dataURL: string,
  integrity: HistoryImageIntegrity,
  declaredSha256: string,
): HistoryImageFile {
  return {
    id: fileId,
    mimeType: "image/png",
    dataURL,
    created: 1_758_000_000_001,
    lastRetrieved: 1_758_000_000_002,
    status: "saved",
    isAnimated: false,
    integrity,
    declaredSha256,
  };
}

function scene(
  elements: readonly HistoryElement[],
  files: Readonly<Record<string, HistoryImageFile>> = {},
): HistoryScene {
  return {
    type: "excalidraw",
    version: 2,
    source: "local-version-history-fixture",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
      zenModeEnabled: false,
      viewModeEnabled: false,
    },
    files,
  };
}

function identity(id: LocalVersionHistoryFixtureId): HistoryDocumentIdentity {
  return {
    workspaceId: `history-fixture-workspace-${id}`,
    documentId: `history-fixture-document-${id}`,
    canonicalPath: `/fixtures/local-version-history/${id}/document.excalidraw`,
    historyRoot: `/fixtures/local-version-history/${id}/version-history`,
  };
}

function fixture(
  id: LocalVersionHistoryFixtureId,
  label: string,
  persistedScene: HistoryScene,
  currentScene: HistoryScene,
  saveState: HistorySaveState,
  imageIntegrity: HistoryImageIntegrity,
  expectedHashes: HistoryFixtureExpectedHashes,
): LocalVersionHistoryFixture {
  return {
    id,
    label,
    identity: identity(id),
    saveState,
    imageIntegrity,
    persistedScene,
    currentScene,
    expectedHashes,
  };
}

const TEXT_SCENE = scene([textElement("text-title", "历史中的文字", 111)]);
const SHAPE_SCENE = scene([
  shapeElement("shape-rectangle", "rectangle", 121),
  shapeElement("shape-diamond", "diamond", 122),
]);
const IMAGE_FILE_ID = "image-pixel";
const VALID_IMAGE_SCENE = scene(
  [imageElement("image-element", IMAGE_FILE_ID, 131)],
  {
    [IMAGE_FILE_ID]: imageFile(
      IMAGE_FILE_ID,
      PNG_DATA_URL,
      "valid",
      "c9e815d03838b73cc3c271f52f0a899102f07b9af4cb371e89cb6fb3ead12f53",
    ),
  },
);
const UNSAVED_PERSISTED_SCENE = scene([
  textElement("unsaved-title", "保存前的文字", 141),
]);
const UNSAVED_CURRENT_SCENE = scene([
  textElement("unsaved-title", "保存前的文字", 141),
  shapeElement("unsaved-shape", "rectangle", 142),
]);
const CORRUPT_FILE_ID = "corrupt-image-pixel";
const CORRUPT_IMAGE_SCENE = scene(
  [imageElement("corrupt-image-element", CORRUPT_FILE_ID, 151)],
  {
    [CORRUPT_FILE_ID]: imageFile(
      CORRUPT_FILE_ID,
      CORRUPT_PNG_DATA_URL,
      "corrupt",
      "c9e815d03838b73cc3c271f52f0a899102f07b9af4cb371e89cb6fb3ead12f53",
    ),
  },
);

/**
 * The expected hashes are intentionally literal. If a scene or image changes,
 * the fixture test fails until its documented baseline is consciously updated.
 */
export const LOCAL_VERSION_HISTORY_FIXTURES: readonly LocalVersionHistoryFixture[] = [
  fixture(
    "text",
    "text-only persisted document",
    TEXT_SCENE,
    TEXT_SCENE,
    "clean",
    "valid",
    {
      persistedSceneSha256: "bd74fda54f7e8cbba351ac33820e27a574c98a6da2c0f1515e658ac8b3a46c5c",
      currentSceneSha256: "bd74fda54f7e8cbba351ac33820e27a574c98a6da2c0f1515e658ac8b3a46c5c",
      documentSha256: "bd74fda54f7e8cbba351ac33820e27a574c98a6da2c0f1515e658ac8b3a46c5c",
      imageSha256: {},
    },
  ),
  fixture(
    "shape",
    "rectangle and diamond persisted document",
    SHAPE_SCENE,
    SHAPE_SCENE,
    "clean",
    "valid",
    {
      persistedSceneSha256: "3dcf1f41aa8d7ddc42360116a1daff8adb9f82e370a03a77ae4c6352b0311d77",
      currentSceneSha256: "3dcf1f41aa8d7ddc42360116a1daff8adb9f82e370a03a77ae4c6352b0311d77",
      documentSha256: "3dcf1f41aa8d7ddc42360116a1daff8adb9f82e370a03a77ae4c6352b0311d77",
      imageSha256: {},
    },
  ),
  fixture(
    "image",
    "persisted document with a valid local image",
    VALID_IMAGE_SCENE,
    VALID_IMAGE_SCENE,
    "clean",
    "valid",
    {
      persistedSceneSha256: "37b0bb00d34f6ac98837f1f71f8b6b0812e2ded4dc34d0c9a60c45294aa42a3a",
      currentSceneSha256: "37b0bb00d34f6ac98837f1f71f8b6b0812e2ded4dc34d0c9a60c45294aa42a3a",
      documentSha256: "37b0bb00d34f6ac98837f1f71f8b6b0812e2ded4dc34d0c9a60c45294aa42a3a",
      imageSha256: {
        [IMAGE_FILE_ID]:
          "c9e815d03838b73cc3c271f52f0a899102f07b9af4cb371e89cb6fb3ead12f53",
      },
    },
  ),
  fixture(
    "unsaved-edit",
    "persisted document with an unsaved shape edit",
    UNSAVED_PERSISTED_SCENE,
    UNSAVED_CURRENT_SCENE,
    "dirty",
    "valid",
    {
      persistedSceneSha256: "fee604870e3d8c7c18ec35284050657a46f2805b4d746da0fcf97b654a3a98ec",
      currentSceneSha256: "26f9cc4a7a7398c4aaf928ac38372c469afd2d3cf9e4e36835f96eeae0576ac9",
      documentSha256: "fee604870e3d8c7c18ec35284050657a46f2805b4d746da0fcf97b654a3a98ec",
      imageSha256: {},
    },
  ),
  fixture(
    "corrupt-image",
    "persisted document whose image bytes are corrupt",
    CORRUPT_IMAGE_SCENE,
    CORRUPT_IMAGE_SCENE,
    "clean",
    "corrupt",
    {
      persistedSceneSha256: "429d2eaf00de35388f246d98a7c726c05a109427ba7f9ed2b07e64aa262ddbb5",
      currentSceneSha256: "429d2eaf00de35388f246d98a7c726c05a109427ba7f9ed2b07e64aa262ddbb5",
      documentSha256: "429d2eaf00de35388f246d98a7c726c05a109427ba7f9ed2b07e64aa262ddbb5",
      imageSha256: {
        [CORRUPT_FILE_ID]:
          "fd72046b133810990869bcb513ec4d1a2700a9c571000d6591becd85e916383a",
      },
    },
  ),
];

export function serializeHistoryScene(sceneValue: HistoryScene): string {
  return JSON.stringify(sceneValue);
}

export function getLocalVersionHistoryFixture(
  id: LocalVersionHistoryFixtureId,
): LocalVersionHistoryFixture {
  const fixtureValue = LOCAL_VERSION_HISTORY_FIXTURES.find(
    (candidate) => candidate.id === id,
  );
  if (fixtureValue === undefined) {
    throw new Error(`Unknown local version history fixture: ${id}`);
  }
  return structuredClone(fixtureValue);
}

export function cloneLocalVersionHistoryFixture(
  fixtureValue: LocalVersionHistoryFixture,
): LocalVersionHistoryFixture {
  return structuredClone(fixtureValue);
}

export function imageBytesFromDataUrl(dataURL: string): Uint8Array {
  const [, encoded] = dataURL.split(",", 2);
  if (encoded === undefined || encoded.length === 0) {
    throw new Error("Fixture image data URL is missing base64 bytes.");
  }
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
