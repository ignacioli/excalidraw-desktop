export type LanguagePreference = "system" | "en" | "zh-CN";
export type ResolvedLanguage = "en" | "zh-CN";

const SIMPLIFIED_CHINESE_REGIONS = new Set(["CN", "SG"]);

function matchTag(tag: string): ResolvedLanguage | undefined {
  const [language = "", ...subtags] = tag.split(/[-_]/u);
  const primary = language.toLowerCase();
  if (primary === "en") return "en";
  if (primary !== "zh") return undefined;

  const script = subtags.find((part) => part.length === 4)?.toLowerCase();
  if (script !== undefined) return script === "hans" ? "zh-CN" : undefined;
  const region = subtags.find((part) => /^[A-Za-z]{2}$/u.test(part));
  if (region === undefined) return "zh-CN";
  return SIMPLIFIED_CHINESE_REGIONS.has(region.toUpperCase())
    ? "zh-CN"
    : undefined;
}

/** The only place that turns a language preference into a UI language. */
export function resolveLanguage(
  preference: LanguagePreference,
  preferredLanguages: readonly string[],
): ResolvedLanguage {
  if (preference !== "system") return preference;
  for (const tag of preferredLanguages) {
    const match = matchTag(tag);
    if (match !== undefined) return match;
  }
  return "en";
}
