import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./resolveLanguage";

describe("resolveLanguage", () => {
  it.each([
    [["zh-Hans-US", "en-US"], "zh-CN"],
    [["en-US", "zh-Hans-US"], "en"],
    [["ja-JP", "zh-Hans-CN"], "zh-CN"],
    [["zh-Hant-TW"], "en"],
    [["zh-TW", "zh-CN"], "zh-CN"],
    [[], "en"],
    [["fr-FR", "de-DE"], "en"],
    [["zh"], "zh-CN"],
  ] as const)("follows the system list %j", (languages, expected) => {
    expect(resolveLanguage("system", languages)).toBe(expected);
  });

  it.each(["zh-Hans", "zh-Hans-SG", "zh-CN", "zh-SG", "zh_CN", "ZH-hans-cn"])(
    "maps simplified Chinese tag %s to zh-CN",
    (tag) => {
      expect(resolveLanguage("system", [tag])).toBe("zh-CN");
    },
  );

  it.each(["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-HK"])(
    "skips traditional Chinese tag %s",
    (tag) => {
      expect(resolveLanguage("system", [tag])).toBe("en");
      expect(resolveLanguage("system", [tag, "zh-Hans"])).toBe("zh-CN");
    },
  );

  it("returns a manual preference without reading the system list", () => {
    expect(resolveLanguage("en", ["zh-Hans-CN"])).toBe("en");
    expect(resolveLanguage("zh-CN", ["en-US"])).toBe("zh-CN");
  });
});
