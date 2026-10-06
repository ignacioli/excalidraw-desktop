import type { SceneSnapshot } from "../editor/sceneSerializer";

export async function createHistoryFrontendEvidence(
  request: { requestId: string; targetVersionId: string },
  documentId: string,
  scene: SceneSnapshot,
) {
  const assetHashes: Record<string, string> = {};
  const decodedImages: Record<string, { width: number; height: number }> = {};
  const elements = scene.elements.filter((element) => !element.isDeleted);
  for (const element of elements) {
    if (element.type !== "image") continue;
    const fileId = element.fileId;
    if (!fileId)
      throw new Error(`Canvas image ${element.id} has no asset reference.`);
    if (assetHashes[fileId] !== undefined) continue;
    const file = scene.files[fileId];
    if (file === undefined || !file.dataURL.startsWith("data:image/")) {
      throw new Error(`Canvas image asset ${fileId} is missing or unresolved.`);
    }
    const match = /^data:image\/[^;,]+;base64,(.+)$/s.exec(file.dataURL);
    if (match === null)
      throw new Error(`Canvas image asset ${fileId} has a malformed data URL.`);
    const bytes = Uint8Array.from(atob(match[1]), (character) =>
      character.charCodeAt(0),
    );
    const image = new Image();
    image.src = file.dataURL;
    try {
      await image.decode();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0)
        throw new Error("Empty image dimensions.");
    } catch (error) {
      throw new Error(`Cannot decode canvas image asset ${fileId}.`, {
        cause: error,
      });
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    assetHashes[fileId] = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    decodedImages[fileId] = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }
  return {
    scenario: "history-frontend-adoption" as const,
    requestId: request.requestId,
    targetVersionId: request.targetVersionId,
    documentId,
    adopted: true as const,
    canvasReadback: {
      elementIds: elements.map((element) => element.id),
      elementTypes: elements.map((element) => element.type),
      elements: elements.map((element) => ({
        id: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        angle: element.angle,
        ...(element.type === "text"
          ? { text: element.text, originalText: element.originalText }
          : {}),
        ...(element.type === "image"
          ? {
              fileId: element.fileId,
              status: element.status,
              scale: element.scale,
            }
          : {}),
      })),
      appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
      assetHashes,
      decodedImages,
    },
  };
}
