import { loadFromBlob } from "@excalidraw/excalidraw";

export async function parseWithOfficialLoader(sceneJson: string): Promise<{
  elementTypes: string[];
  fileCount: number;
}> {
  const restored = await loadFromBlob(
    new Blob([sceneJson], { type: "application/json" }),
    null,
    null,
  );
  return {
    elementTypes: (restored.elements ?? []).map((element) => element.type),
    fileCount: Object.keys(restored.files ?? {}).length,
  };
}
