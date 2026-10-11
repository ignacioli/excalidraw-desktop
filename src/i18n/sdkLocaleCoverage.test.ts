import { describe, expect, it } from "vitest";

// Guards the pnpm patch that completes the SDK's zh-CN catalog. When the SDK
// is upgraded, a renamed locale file or a new English key fails here, which
// means the patch must be redone (or dropped once upstream has the strings).
const localeModules = import.meta.glob<Record<string, LocaleTree>>(
  "/node_modules/@excalidraw/excalidraw/dist/{dev,prod}/locales/{en,zh-CN}-*.js",
);

// Keys the app never renders may be listed here, each with a reason.
const UNRENDERED_KEY_EXCEPTIONS: ReadonlyMap<string, string> = new Map();

type LocaleTree = { readonly [key: string]: string | LocaleTree };

function flatten(tree: LocaleTree, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") {
      entries.set(`${prefix}${key}`, value);
    } else {
      flatten(value, `${prefix}${key}.`).forEach((v, k) => entries.set(k, v));
    }
  }
  return entries;
}

async function loadLocale(build: string, code: string) {
  const prefix = `/node_modules/@excalidraw/excalidraw/dist/${build}/locales/${code}-`;
  const matches = Object.keys(localeModules).filter((path) =>
    path.startsWith(prefix),
  );
  const [path] = matches;
  if (path === undefined || matches.length !== 1) {
    throw new Error(`Expected one ${code} locale file in ${build}: ${matches}`);
  }
  // The SDK reads translations from the module namespace (named section
  // exports), not from the default export, so check exactly that.
  const namespace = await localeModules[path]!();
  return flatten(
    Object.fromEntries(
      Object.entries(namespace).filter(([name]) => name !== "default"),
    ),
  );
}

describe.each(["dev", "prod"])("SDK zh-CN locale (%s build)", (build) => {
  it("translates every English key", async () => {
    const english = await loadLocale(build, "en");
    const chinese = await loadLocale(build, "zh-CN");

    const missing = [...english.keys()].filter(
      (key) =>
        !UNRENDERED_KEY_EXCEPTIONS.has(key) &&
        (chinese.get(key) ?? "").trim() === "",
    );

    expect(english.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
