import { describe, expect, it } from "vitest";
import {
  SHELL_FIXTURES,
  assertShellFixtureConsistency,
  getShellFixture,
  type ShellFixture,
} from "./003-shell-fixtures";

describe("003 shell fixtures", () => {
  it("keeps every declared fixture internally consistent before browser setup", () => {
    for (const fixture of SHELL_FIXTURES) {
      expect(() => assertShellFixtureConsistency(fixture)).not.toThrow();
    }
  });

  it("rejects a tab whose title does not match its drawing entry", () => {
    const fixture = getShellFixture("overlay");
    const inconsistent: ShellFixture = {
      ...fixture,
      tabs: fixture.tabs.map((tab, index) =>
        index === 2 ? { ...tab, title: "Wrong title" } : tab,
      ),
    };

    expect(() => assertShellFixtureConsistency(inconsistent)).toThrow(
      /tab title .* does not match drawing .* display name/iu,
    );
  });

  it("rejects duplicate tab paths and unresolved directory state", () => {
    const fixture = getShellFixture("overlay");
    const inconsistent: ShellFixture = {
      ...fixture,
      expandedDirectoryPaths: ["missing-directory"],
      tabs: fixture.tabs.map((tab, index) =>
        index === 2 ? { ...tab, path: fixture.tabs[0]?.path ?? null } : tab,
      ),
    };

    expect(() => assertShellFixtureConsistency(inconsistent)).toThrow(
      /duplicate tab path|expanded directory .* does not resolve/iu,
    );
  });
});
