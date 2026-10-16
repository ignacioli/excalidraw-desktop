// Spanish catalog. Area groups and the remaining English strings are
// placeholders; language autonyms are final. Keep this file to TypeScript
// syntax that Node can strip directly: scripts/native-menu-check.mjs imports it.
import { documentsEs } from "./documents.ts";
import { en, type MessageKey } from "./en.ts";
import { historyEs } from "./history.ts";
import { shellEs } from "./shell.ts";

export const es: Record<MessageKey, string> = {
  ...en,
  ...shellEs,
  ...documentsEs,
  ...historyEs,
};
