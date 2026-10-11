import { describe, expect, it } from "vitest";
import { formatDateTimeIn, translate } from "./index";

describe("translate", () => {
  it("returns the message for the requested language", () => {
    expect(translate("en", "menu.canvas.preferences")).toBe("Preferences");
    expect(translate("zh-CN", "menu.canvas.preferences")).toBe("偏好设置");
  });

  it("interpolates named parameters", () => {
    expect(
      translate("zh-CN", "menu.native.app.about", { name: "Excalidraw" }),
    ).toBe("关于 Excalidraw");
  });

  it("reports a missing parameter in development builds", () => {
    expect(() => translate("en", "menu.native.app.quit")).toThrow(/name/u);
  });
});

describe("formatDateTimeIn", () => {
  it("formats with the resolved language instead of the host locale", () => {
    const date = new Date(Date.UTC(2026, 9, 9, 12));
    const options = { month: "long", timeZone: "UTC" } as const;
    expect(formatDateTimeIn("en", date, options)).toBe("October");
    expect(formatDateTimeIn("zh-CN", date, options)).toBe("十月");
  });
});
