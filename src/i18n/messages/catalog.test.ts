import { describe, expect, it } from "vitest";
import { documentsEn } from "./documents.ts";
import { en, type MessageKey } from "./en.ts";
import { es } from "./es.ts";
import { historyEn } from "./history.ts";
import { ja } from "./ja.ts";
import { shellEn } from "./shell.ts";
import { zhCN } from "./zh-CN.ts";

// Proper nouns and symbols that read the same in English and Simplified Chinese.
const SAME_IN_BOTH_LANGUAGES: ReadonlySet<MessageKey> = new Set([
  "language.autonym.en",
  "language.autonym.zhCN",
  "language.autonym.es",
  "language.autonym.ja",
  // The em dash separator is the macOS title convention in both languages.
  "shell.windowTitle.drawing",
]);

describe("message catalogs", () => {
  it("translates every English message into Simplified Chinese", () => {
    const untranslated = (Object.keys(en) as MessageKey[]).filter(
      (key) =>
        !SAME_IN_BOTH_LANGUAGES.has(key) &&
        (zhCN[key].trim() === "" || zhCN[key] === en[key]),
    );
    expect(untranslated).toEqual([]);
  });

  it("only lists proper nouns that exist and match", () => {
    for (const key of SAME_IN_BOTH_LANGUAGES) {
      expect(zhCN[key], key).toBe(en[key]);
    }
  });

  it("keeps language autonyms in the Spanish and Japanese catalogs", () => {
    for (const catalog of [es, ja]) {
      expect(catalog["language.autonym.en"]).toBe("English");
      expect(catalog["language.autonym.zhCN"]).toBe("简体中文");
      expect(catalog["language.autonym.es"]).toBe("Español");
      expect(catalog["language.autonym.ja"]).toBe("日本語");
    }
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(zhCN[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("never defines a key in more than one area file", () => {
    const counts = new Map<string, number>();
    for (const area of [shellEn, documentsEn, historyEn]) {
      for (const key of Object.keys(area)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const duplicated = [...counts].filter(([, count]) => count > 1);
    expect(duplicated).toEqual([]);
  });
});
