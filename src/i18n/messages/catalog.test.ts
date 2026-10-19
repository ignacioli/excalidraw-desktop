import { describe, expect, it } from "vitest";
import { documentsEn } from "./documents.ts";
import { en, type MessageKey } from "./en.ts";
import { es } from "./es.ts";
import { historyEn } from "./history.ts";
import { ja } from "./ja.ts";
import { shellEn } from "./shell.ts";
import { zhCN } from "./zh-CN.ts";

// Strings that stay identical to English, each with the reason they are not a missed translation.
const SAME_AS_ENGLISH: Record<"es" | "ja", ReadonlyMap<MessageKey, string>> = {
  es: new Map([
    [
      "language.autonym.en",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.zhCN",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.es",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.ja",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "shell.windowTitle.drawing",
      "Window-title pattern. The em dash is the separator, not a word.",
    ],
    [
      "shell.windowTitle.sameName",
      "Window-title pattern of a name and its parent. There is no word to translate.",
    ],
    [
      "welcome.eyebrow",
      "The product name Excalidraw Desktop is not translated.",
    ],
    [
      "export.scaleOption",
      "Scale notation. The x is a multiplier, not a word.",
    ],
    [
      "history.source.manual",
      "The Spanish adjective Manual is spelled the same as English.",
    ],
    [
      "history.deleteSource.manual",
      "The lowercase Spanish adjective manual is spelled the same as English.",
    ],
    [
      "history.panel.feedback.announce",
      "Two placeholders joined by a middle dot. There is no word to translate.",
    ],
    [
      "menu.native.window.zoom",
      "The macOS Spanish Window menu keeps the label Zoom.",
    ],
  ]),
  ja: new Map([
    [
      "language.autonym.en",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.zhCN",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.es",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "language.autonym.ja",
      "Language name, shown unchanged in every interface language.",
    ],
    [
      "shell.windowTitle.drawing",
      "Window-title pattern. The em dash is the separator, not a word.",
    ],
    [
      "welcome.eyebrow",
      "The product name Excalidraw Desktop is not translated.",
    ],
    [
      "export.scaleOption",
      "Scale notation. The x is a multiplier, not a word.",
    ],
    [
      "history.panel.feedback.announce",
      "Two placeholders joined by a middle dot. There is no word to translate.",
    ],
  ]),
};

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

  it("keeps the same placeholders in every language", () => {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    for (const key of Object.keys(en) as MessageKey[]) {
      const expected = placeholders(en[key]);
      for (const [name, catalog] of [
        ["zh-CN", zhCN],
        ["es", es],
        ["ja", ja],
      ] as const) {
        expect(placeholders(catalog[key]), `${name} ${key}`).toEqual(expected);
      }
    }
  });

  it("translates every English message into Spanish and Japanese", () => {
    for (const [name, catalog, allowed] of [
      ["es", es, SAME_AS_ENGLISH.es],
      ["ja", ja, SAME_AS_ENGLISH.ja],
    ] as const) {
      const untranslated = (Object.keys(en) as MessageKey[]).filter(
        (key) =>
          !allowed.has(key) &&
          (catalog[key].trim() === "" || catalog[key] === en[key]),
      );
      expect(untranslated, name).toEqual([]);
      for (const [key, reason] of allowed) {
        expect(reason.trim().length, key).toBeGreaterThan(0);
        expect(catalog[key], `${name} ${key}`).toBe(en[key]);
      }
    }
  });

  it("keeps native menu labels and language names within 64 characters", () => {
    for (const catalog of [en, zhCN, es, ja]) {
      for (const key of Object.keys(catalog) as MessageKey[]) {
        if (
          !key.startsWith("menu.native.") &&
          !key.startsWith("language.autonym.")
        ) {
          continue;
        }
        expect([...catalog[key]].length, key).toBeLessThanOrEqual(64);
      }
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

// Glossary entry names sit on each rule. Punctuation rules have no term-table
// entry; the label says which general rule they enforce.
const GLOSSARY_RULES: readonly {
  language: "es" | "ja";
  entry: string;
  matches: (key: MessageKey, value: string) => boolean;
}[] = [
  // folder
  {
    language: "es",
    entry: "folder",
    matches: (_key, value) => value.includes("directorio"),
  },
  // Recovery
  {
    language: "es",
    entry: "Recovery",
    matches: (key, value) =>
      key.startsWith("recovery.") && value.includes("restaur"),
  },
  // file. ordenador is banned with fichero and has no separate term entry.
  {
    language: "es",
    entry: "file",
    matches: (_key, value) =>
      value.includes("ordenador") || value.includes("fichero"),
  },
  // Spanish questions require an opening ¿. No term-table entry.
  {
    language: "es",
    entry: "question punctuation",
    matches: (_key, value) => value.includes("?") && !value.includes("¿"),
  },
  // folder
  {
    language: "ja",
    entry: "folder",
    matches: (_key, value) => value.includes("ディレクトリ"),
  },
  // Export
  {
    language: "ja",
    entry: "Export",
    matches: (_key, value) => value.includes("書き出"),
  },
  // Recovery. 復元 belongs to Restore.
  {
    language: "ja",
    entry: "Recovery",
    matches: (key, value) =>
      key.startsWith("recovery.") && value.includes("復元"),
  },
  // Restore. 復旧 belongs to Recovery.
  {
    language: "ja",
    entry: "Restore",
    matches: (key, value) =>
      key.startsWith("history.") && value.includes("復旧"),
  },
  // Japanese quotations use 「」. No term-table entry.
  {
    language: "ja",
    entry: "quotation marks",
    matches: (_key, value) => value.includes("“") || value.includes("”"),
  },
  // Japanese parentheses are full-width. No term-table entry.
  {
    language: "ja",
    entry: "parentheses",
    matches: (_key, value) => value.includes("("),
  },
  // Full-width ：「（ already include space, so no extra half-width space.
  {
    language: "ja",
    entry: "punctuation spacing",
    matches: (_key, value) => /[：「（] /u.test(value),
  },
];

// Keys that match a rule on purpose. Each reason says why the hit is kept.
const GLOSSARY_EXCEPTIONS: readonly {
  language: "es" | "ja";
  key: MessageKey;
  entry: string;
  reason: string;
}[] = [];

describe("glossary terminology", () => {
  it("rejects banned Spanish and Japanese wording", () => {
    const catalogs = { es, ja } as const;
    const violations: string[] = [];
    for (const rule of GLOSSARY_RULES) {
      const catalog = catalogs[rule.language];
      for (const key of Object.keys(catalog) as MessageKey[]) {
        if (!rule.matches(key, catalog[key])) continue;
        const allowed = GLOSSARY_EXCEPTIONS.some(
          (exception) =>
            exception.language === rule.language &&
            exception.key === key &&
            exception.entry === rule.entry &&
            exception.reason.trim().length > 0,
        );
        if (!allowed) {
          violations.push(`${rule.language} ${rule.entry} ${key}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps glossary exceptions tied to a live rule and a reason", () => {
    const catalogs = { es, ja } as const;
    for (const exception of GLOSSARY_EXCEPTIONS) {
      expect(exception.reason.trim().length, exception.key).toBeGreaterThan(0);
      const rule = GLOSSARY_RULES.find(
        (candidate) =>
          candidate.language === exception.language &&
          candidate.entry === exception.entry,
      );
      expect(rule, `${exception.language} ${exception.entry}`).toBeDefined();
      expect(
        rule?.matches(
          exception.key,
          catalogs[exception.language][exception.key],
        ),
        exception.key,
      ).toBe(true);
    }
  });
});
