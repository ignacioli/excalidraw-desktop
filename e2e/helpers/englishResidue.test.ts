import { describe, expect, it } from "vitest";

import { englishResidue, SPANISH_UI_WORDS } from "./englishResidue";

const spanish = {
  catalogWords: SPANISH_UI_WORDS,
  matchLetters: true,
} as const;

describe("englishResidue", () => {
  it("flags untranslated English and accepts a Spanish sentence", () => {
    expect(englishResidue(["Excalidraw drawing"], spanish)).toEqual([
      "Excalidraw drawing",
    ]);
    expect(
      englishResidue(["El dibujo actual no ha cambiado."], spanish),
    ).toEqual([]);
  });

  it("does not treat placeholder names or split accents as Spanish words", () => {
    expect(SPANISH_UI_WORDS.has("drawing")).toBe(false);
    expect(SPANISH_UI_WORDS.has("workspace")).toBe(false);
    expect(SPANISH_UI_WORDS.has("count")).toBe(false);
    expect(SPANISH_UI_WORDS.has("Versi")).toBe(false);
    expect(SPANISH_UI_WORDS.has("versión")).toBe(true);
  });

  it("keeps the Chinese and Japanese scan on ASCII letters", () => {
    expect(englishResidue(["切换工作区侧边栏"])).toEqual([]);
    expect(englishResidue(["ワークスペース"])).toEqual([]);
    expect(englishResidue(["Excalidraw drawing"])).toEqual([
      "Excalidraw drawing",
    ]);
  });
});
