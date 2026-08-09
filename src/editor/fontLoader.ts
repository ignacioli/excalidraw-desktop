declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const EXCALIDRAW_ASSET_PATH = "/fonts/";
export const CJK_HANDWRITING_FONT_URL = "/fonts/Virgil-CJK.woff2";

export function configureExcalidrawAssets(): void {
  window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}

export async function loadBundledCjkFont(): Promise<void> {
  if (!("FontFace" in window) || !("fonts" in document)) {
    return;
  }

  const font = new FontFace(
    "Xiaolai",
    `url(${JSON.stringify(CJK_HANDWRITING_FONT_URL)}) format("woff2")`,
    { display: "swap", style: "normal", weight: "400" },
  );
  await font.load();
  document.fonts.add(font);
}

export {};
