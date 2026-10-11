import { describe, expect, it } from "vitest";

// Guards the pnpm patch that names the SDK's canvas menu trigger. An SDK
// upgrade that drops or reshapes the patched line fails here.
const builds = import.meta.glob<string>(
  "/node_modules/@excalidraw/excalidraw/dist/{dev,prod}/index.js",
  { query: "?raw", import: "default" },
);

const PATCHED_TRIGGER: Readonly<Record<string, RegExp>> = {
  dev: /"data-testid": "main-menu-trigger",\s+"aria-label": t\("buttons\.menu"\),/g,
  prod: /"data-testid":"main-menu-trigger","aria-label":g\("buttons\.menu"\),/g,
};

describe("SDK canvas menu trigger patch", () => {
  it.each(["dev", "prod"])(
    "gives the %s build's menu trigger the SDK Menu label",
    async (build) => {
      const load =
        builds[`/node_modules/@excalidraw/excalidraw/dist/${build}/index.js`];
      expect(load).toBeDefined();
      const source = await load!();
      expect(source.match(PATCHED_TRIGGER[build]!)).toHaveLength(1);
    },
  );
});
