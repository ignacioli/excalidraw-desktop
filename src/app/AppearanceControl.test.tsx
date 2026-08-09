import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeController } from "./theme/themeController";
import { AppearanceControl } from "./AppearanceControl";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const colorSchemeMedia = {
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

describe("AppearanceControl", () => {
  it("exposes the three appearance choices as an accessible radio group", async () => {
    const user = userEvent.setup();
    const controller = new ThemeController({
      storage: new MemoryStorage(),
      colorSchemeMedia,
      root: document.createElement("html"),
    });

    render(<AppearanceControl controller={controller} />);

    expect(
      screen.getByRole("group", { name: "Appearance" }),
    ).toBeInTheDocument();
    const system = screen.getByRole("radio", { name: "System" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(system).toBeChecked();

    await user.click(dark);

    expect(dark).toBeChecked();
    expect(controller.getSnapshot().preference.modePreference).toBe("dark");
    controller.dispose();
  });
});
