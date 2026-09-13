import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EXPECTED_MENU_ITEMS,
  EXPECTED_WINDOW_SIZE,
  NativeValidationBlockedError,
  adaptNativeValidationReport,
  aggregateStatus,
  ambiguousAppProcesses,
  buildReport,
  compareBundleContract,
  compareManifest,
  compareMenuObservation,
  decodeAXModifiers,
  inspectMenuItemAppleScript,
  makeCheck,
  parseNativeValidationEvents,
  parseNativeValidationLine,
  resolveMenuItemAppleScript,
  sha256Path,
  validatePreparedNativeProfile,
  validationPair,
  writeNativeValidationCollection,
} from "./native-macos-validation.mjs";

describe("native macOS validation helpers", () => {
  it(
    "generates AppleScript that compiles before native menu inspection",
    { skip: process.platform !== "darwin" },
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "excalidraw-native-menu-script-"),
      );
      try {
        const scripts = [
          resolveMenuItemAppleScript(
            123,
            ["File", "Save"],
            "click targetItem",
          ),
          inspectMenuItemAppleScript(123, EXPECTED_MENU_ITEMS[0]),
        ];
        for (const [index, script] of scripts.entries()) {
          const output = path.join(root, `menu-${index}.scpt`);
          const compiled = spawnSync(
            "osacompile",
            ["-e", script, "-o", output],
            { encoding: "utf8" },
          );
          assert.equal(compiled.status, 0, compiled.stderr);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("parses only valid structured probe lines", () => {
    assert.deepEqual(
      parseNativeValidationLine(
        'EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"nativeEntry","validationId":7,"command":"save"}',
      ),
      { stage: "nativeEntry", validationId: 7, command: "save" },
    );
    assert.equal(
      parseNativeValidationLine("noise EXCALIDRAW_NATIVE_MENU_VALIDATION {}"),
      null,
    );
    assert.equal(
      parseNativeValidationLine(
        'EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"nativeEntry","validationId":0,"command":"save"}',
      ),
      null,
    );
  });

  it("matches native-entry and application-route probes by validation id", () => {
    const events = parseNativeValidationEvents(
      [
        'EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"nativeEntry","validationId":9,"command":"exportImage"}',
        'EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"applicationRoute","validationId":9,"command":"exportImage"}',
      ].join("\n"),
    );
    assert.deepEqual(validationPair(events, "exportImage"), {
      validationId: 9,
      command: "exportImage",
      stages: ["applicationRoute", "nativeEntry"],
    });
    assert.equal(validationPair(events, "exportImage", new Set([9])), null);
  });

  it("decodes AX menu modifier bitmasks", () => {
    assert.deepEqual(decodeAXModifiers(0), ["command"]);
    assert.deepEqual(decodeAXModifiers(1), ["command", "shift"]);
    assert.deepEqual(decodeAXModifiers(2), ["command", "option"]);
    assert.deepEqual(decodeAXModifiers(10), ["option"]);
    assert.deepEqual(decodeAXModifiers(8), []);
    assert.deepEqual(decodeAXModifiers("bad"), []);
  });

  it("checks menu label, enabled state, and keyboard equivalence", () => {
    const expected = EXPECTED_MENU_ITEMS[1];
    assert.equal(
      compareMenuObservation(expected, {
        label: "Export Image",
        enabled: true,
        keyboard: { character: "E", modifiers: 2 },
      }).pass,
      true,
    );
    assert.equal(
      compareMenuObservation(expected, {
        label: "Export Image",
        enabled: true,
        keyboard: { character: "e", modifiers: 1 },
      }).pass,
      false,
    );
  });

  it("keeps package identity mismatches explicit", () => {
    assert.deepEqual(
      compareManifest(
        {
          appPath: "/tmp/Excalidraw.app",
          bundleIdentifier: "excalidraw-desktop",
          version: "0.2.0",
          buildVersion: "1",
          executable: "excalidraw-desktop",
          executableSha256: "a",
          packageSha256: "b",
          artifactSha256: "b",
        },
        {
          appPath: "/tmp/Excalidraw.app",
          bundleIdentifier: "wrong.bundle",
          version: "0.2.0",
          buildVersion: "1",
          executable: "excalidraw-desktop",
          executableSha256: "a",
          packageSha256: "b",
          artifactSha256: "b",
        },
      ),
      [
        {
          field: "bundleIdentifier",
          expected: "excalidraw-desktop",
          actual: "wrong.bundle",
        },
      ],
    );
  });

  it("rejects package metadata or paths outside the configured production bundle", () => {
    assert.deepEqual(
      compareBundleContract(
        {
          appPath: "/repo/src-tauri/target/release/bundle/macos/Excalidraw.app",
          bundleIdentifier: "excalidraw-desktop",
          version: "0.2.0",
          executable: "excalidraw-desktop",
        },
        {
          appPath: "/tmp/Excalidraw.app",
          bundleIdentifier: "other.app",
          version: "0.2.0",
          executable: "excalidraw-desktop",
        },
      ),
      [
        {
          field: "appPath",
          expected:
            "/repo/src-tauri/target/release/bundle/macos/Excalidraw.app",
          actual: "/tmp/Excalidraw.app",
        },
        {
          field: "bundleIdentifier",
          expected: "excalidraw-desktop",
          actual: "other.app",
        },
      ],
    );
  });

  it("includes symlink topology in package identity", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-native-validation-hash-"),
    );
    try {
      await fs.writeFile(path.join(root, "payload"), "same", "utf8");
      await fs.symlink("payload", path.join(root, "active"));
      const first = await sha256Path(root);
      await fs.unlink(path.join(root, "active"));
      await fs.symlink("missing", path.join(root, "active"));
      const second = await sha256Path(root);
      assert.notEqual(first, second);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous app processes by listing them without killing", () => {
    const processes = ambiguousAppProcesses(
      "/Applications/Excalidraw.app/Contents/MacOS/excalidraw-desktop",
      "excalidraw-desktop",
      [
        "  123 /Applications/Excalidraw.app/Contents/MacOS/excalidraw-desktop /Applications/Excalidraw.app/Contents/MacOS/excalidraw-desktop",
        "  456 /usr/bin/other /usr/bin/other",
      ].join("\n"),
    );
    assert.equal(processes.length, 1);
    assert.match(processes[0], /123/u);
  });

  it("aggregates failures before blocked environment checks", () => {
    assert.equal(aggregateStatus(["PASS", "BLOCKED"]), "BLOCKED");
    assert.equal(aggregateStatus(["PASS", "FAIL", "BLOCKED"]), "FAIL");
    const report = buildReport({
      command: "validate",
      checks: [{ id: "x", status: "PASS" }],
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.command, "validate");
    assert.equal(report.status, "PASS");
    assert.deepEqual(EXPECTED_WINDOW_SIZE, { width: 1280, height: 760 });
  });

  it("does not let diagnostic details overwrite PASS/FAIL/BLOCKED status", () => {
    const check = makeCheck("clean", "clean worktree", "BLOCKED", {
      status: " M user-owned-file",
    });
    assert.equal(check.status, "BLOCKED");
    assert.equal(
      buildReport({ command: "seal", checks: [check] }).status,
      "BLOCKED",
    );
  });

  it("adapts native output without crossing reviewer or owner roles", async () => {
    const binding = {
      productCommit: "ab".repeat(20),
      hf2ManifestSha256: "cd".repeat(32),
      fixtureDigest: "ef".repeat(32),
      harnessVersion: "native-v2",
      packageArtifactSha256: "12".repeat(32),
    };
    const report = buildReport({
      command: "validate",
      environment: { productVersion: "macOS 26.5.2" },
      manifest: { appPath: "/tmp/Excalidraw.app" },
      checks: [
        makeCheck("native-menu", "menu", "PASS"),
        makeCheck("save-menu", "save", "PASS", {
          command: "save",
          validationId: 7,
        }),
        makeCheck("save-filesystem-outcome", "saved", "PASS"),
      ],
    });
    const adapted = adaptNativeValidationReport(report, binding);
    assert.equal(adapted.environment.route, "macos-accessibility");
    assert.equal(adapted.routeAcknowledgements.actions[0].validationId, 7);
    assert.equal(adapted.filesystemOutcomes.result, "PASS");
    assert.equal("reviewerVerdict" in adapted.environment, false);
    assert.equal("productOwnerDecision" in adapted.environment, false);

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-native-adapter-"),
    );
    try {
      const collection = path.join(root, "collection");
      const collectorReport = await writeNativeValidationCollection(
        collection,
        report,
        binding,
      );
      assert.equal(collectorReport.result, "PASS");
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(collection, "environment.json"), "utf8"),
        ).binding.packageArtifactSha256,
        binding.packageArtifactSha256,
      );
      await assert.rejects(
        writeNativeValidationCollection(collection, report, binding),
        /already exists/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed native collection bindings", () => {
    assert.throws(
      () => adaptNativeValidationReport(buildReport({ checks: [] }), {}),
      /binding\.productCommit/u,
    );
  });

  it("binds T023b to its distinct prepared disposable profile", () => {
    const profileRoot = "/tmp/run/profiles/T023b";
    const plan = {
      schemaVersion: 2,
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      productCommit: "ab".repeat(20),
      isolation: { root: "/tmp/run" },
      packageManifest: { artifactSha256: "ef".repeat(32) },
      screens: [{ gateId: "HF2-01" }],
    };
    const result = validatePreparedNativeProfile(plan, {
      gitCommit: "ab".repeat(20),
      artifactSha256: "ef".repeat(32),
    });
    assert.equal(result.profileRoot, profileRoot);
    assert.equal(result.environment.HOME, profileRoot);
    assert.equal("EXCALIDRAW_NATIVE_CAPTURE_PLAN" in result.environment, false);
    assert.throws(
      () =>
        validatePreparedNativeProfile(
          {
            ...plan,
            packageManifest: { artifactSha256: "12".repeat(32) },
          },
          {
            gitCommit: "ab".repeat(20),
            artifactSha256: "ef".repeat(32),
          },
        ),
      NativeValidationBlockedError,
    );
  });
});
