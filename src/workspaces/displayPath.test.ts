import { describe, expect, it } from "vitest";
import { abbreviateHome } from "./displayPath";

describe("abbreviateHome", () => {
  it("shows paths inside the home directory with ~", () => {
    expect(abbreviateHome("/Users/a/Drawings/x.excalidraw", "/Users/a")).toBe(
      "~/Drawings/x.excalidraw",
    );
    expect(abbreviateHome("/Users/a/Drawings", "/Users/a/")).toBe("~/Drawings");
    expect(abbreviateHome("/Users/a", "/Users/a")).toBe("~");
  });

  it("leaves other paths unchanged", () => {
    expect(abbreviateHome("/Users/ab/x.excalidraw", "/Users/a")).toBe(
      "/Users/ab/x.excalidraw",
    );
    expect(abbreviateHome("/Volumes/USB/x.excalidraw", "/Users/a")).toBe(
      "/Volumes/USB/x.excalidraw",
    );
    expect(abbreviateHome("/Users/a/x.excalidraw", null)).toBe(
      "/Users/a/x.excalidraw",
    );
  });
});
