// Japanese catalog. Area groups and the remaining English strings are
// placeholders; language autonyms are final. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports it.
import { documentsJa } from "./documents.ts";
import { en, type MessageKey } from "./en.ts";
import { historyJa } from "./history.ts";
import { shellJa } from "./shell.ts";

export const ja: Record<MessageKey, string> = {
  ...en,
  ...shellJa,
  ...documentsJa,
  ...historyJa,
};
