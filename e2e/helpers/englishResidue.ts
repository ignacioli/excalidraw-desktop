import { en } from "../../src/i18n/messages/en.ts";
import { es } from "../../src/i18n/messages/es.ts";

// Proper nouns, fixture data, and shortcut notation allowed in every UI language.
export const ALLOWED_LATIN: ReadonlySet<string> = new Set([
  "Excalidraw",
  "Virtual",
  "Workspace",
  "first",
  "second",
  "excalidraw",
  "json",
  "Cmd",
  "Option",
  "Shift",
  "PNG",
  "SVG",
]);

const EMPTY_WORDS: ReadonlySet<string> = new Set();

function words(values: readonly string[], pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const value of values) {
    // Placeholder names such as {drawing} are not copy. Remove them before
    // taking words so they cannot whitelist an untranslated English word.
    const stripped = value.replace(/\{\w+\}/gu, " ");
    for (const match of stripped.match(pattern) ?? []) found.add(match);
  }
  return found;
}

/**
 * Words that may appear in Spanish UI.
 *
 * Spanish is Latin script, so the live scan cannot treat every Latin word as
 * English. A handwritten allowlist would have to copy the Spanish catalog and
 * could quietly include an English word. This set is the smaller, stricter
 * rule: keep a word only when the Spanish catalog contains it and the English
 * catalog does not use it as an English word (`[A-Za-z]{3,}`). Accented
 * letters stay inside the word (`\p{L}`), so "versión" is not stored as "Versi".
 * Chinese and Japanese do not use this set.
 */
export function spanishUiWords(
  spanish: Readonly<Record<string, string>>,
  english: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const englishWords = new Set(
    [...words(Object.values(english), /[A-Za-z]{3,}/gu)].map((word) =>
      word.toLowerCase(),
    ),
  );
  return new Set(
    [...words(Object.values(spanish), /\p{L}{3,}/gu)].filter(
      (word) => !englishWords.has(word.toLowerCase()),
    ),
  );
}

export const SPANISH_UI_WORDS = spanishUiWords(es, en);

export function englishResidue(
  texts: readonly string[],
  options: {
    readonly catalogWords?: ReadonlySet<string>;
    readonly matchLetters?: boolean;
  } = {},
): string[] {
  // Chinese and Japanese stay on the ASCII scan. Letter matching is only for
  // Spanish, where an accented word must be judged whole.
  const pattern = options.matchLetters ? /\p{L}{3,}/gu : /[A-Za-z]{3,}/gu;
  const catalogWords = options.catalogWords ?? EMPTY_WORDS;
  return texts.filter((text) =>
    (text.match(pattern) ?? []).some(
      (word) => !ALLOWED_LATIN.has(word) && !catalogWords.has(word),
    ),
  );
}
