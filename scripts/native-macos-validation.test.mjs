import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EXPECTED_MENU_ITEMS,
  EXPECTED_WINDOW_SIZE,
  NATIVE_ACTION_STEPS,
  PROOF_SCOPES,
  PRODUCTION_APP_BUILD_ARGS,
  NativeValidationBlockedError,
  adaptNativeValidationReport,
  aggregateStatus,
  ambiguousAppProcesses,
  buildAttemptRecord,
  buildReport,
  compareBundleContract,
  compareManifest,
  compareMenuObservation,
  commandSConfirmationLine,
  completeExportDialogAppleScript,
  decodeAXModifiers,
  inspectMenuItemAppleScript,
  makeCheck,
  nativeActionsForScope,
  nativeMenuItemsForScope,
  parseCommandSConfirmation,
  parseFrontmostPid,
  parseWindowGeometryOutput,
  parseNativeValidationEvents,
  parseNativeValidationLine,
  resolveMenuItemAppleScript,
  runtimeProductIdentitySha256,
  sha256Path,
  physicalCommandSObserverSwiftSource,
  frontmostProcessAppleScript,
  validateStopReopenDecision,
  validatePreparedNativeProfile,
  validationPair,
  windowGeometryAppleScript,
  writeNativeValidationCollection,
} from "./native-macos-validation.mjs";

const NATIVE_VALIDATOR_SOURCE_SHA256 = crypto
  .createHash("sha256")
  .update(
    await fs.readFile(
      new URL("./native-macos-validation.mjs", import.meta.url),
    ),
  )
  .digest("hex");

function nativeBinding(overrides = {}) {
  return {
    productCommit: "ab".repeat(20),
    hf2ManifestSha256: "cd".repeat(32),
    fixtureDigest: "ef".repeat(32),
    packageArtifactSha256: "12".repeat(32),
    nativeEntrypointProfileSha256: "23".repeat(32),
    productIdentity: {
      runtimeInputsSha256: "34".repeat(32),
      packageArtifactSha256: "12".repeat(32),
      bundleIdentifier: "excalidraw-desktop",
      version: "0.2.0",
    },
    validatorIdentity: {
      producer: "native-macos-validation",
      version: "4",
      sourceSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
      schemaVersion: 3,
    },
    attemptIdentity: {
      attemptId: "T023b-001-native-router",
      gate: "T023b",
      platform: "macos",
      inputSha256: "56".repeat(32),
    },
    namedChangeSincePreviousAttempt: {
      changeId: "T058d-native-route-scope",
      producer: "native-macos-validation",
      beforeSha256: "67".repeat(32),
      afterSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
    },
    rootCauseClass: "HARNESS",
    consecutiveFailureCount: 0,
    proofScope: PROOF_SCOPES.FINAL,
    remediationEpoch: 0,
    reopenDecision: null,
    repairTarget: null,
    ...overrides,
  };
}

describe("native macOS validation helpers", () => {
  it("seals only the production app bundle required by native validation", () => {
    assert.deepEqual(PRODUCTION_APP_BUILD_ARGS, [
      "tauri",
      "build",
      "--bundles",
      "app",
    ]);
  });

  it("keeps qualification minimal while final preserves all seven actions", () => {
    assert.deepEqual(
      nativeActionsForScope(PROOF_SCOPES.QUALIFICATION).map(({ id }) => id),
      ["save-keyboard", "save-menu"],
    );
    assert.deepEqual(
      nativeActionsForScope(PROOF_SCOPES.FINAL).map(({ id }) => id),
      [
        "save-keyboard",
        "save-menu",
        "export-menu",
        "export-keyboard",
        "appearance-system",
        "appearance-light",
        "appearance-dark",
      ],
    );
    assert.equal(nativeMenuItemsForScope(PROOF_SCOPES.QUALIFICATION).length, 1);
    assert.equal(nativeMenuItemsForScope(PROOF_SCOPES.FINAL).length, 5);
  });

  it("accepts one exact nonce confirmation and rejects mismatch or duplication", () => {
    const expected = commandSConfirmationLine("ab".repeat(16));
    assert.equal(expected, `COMMAND-S T023b ${"ab".repeat(16)}`);
    assert.equal(
      parseCommandSConfirmation(`${expected}\n`, expected),
      expected,
    );
    assert.throws(
      () => parseCommandSConfirmation("ready\n", expected),
      /exactly match/u,
    );
    assert.throws(
      () => parseCommandSConfirmation(`${expected}\n${expected}\n`, expected),
      /exactly one line/u,
    );
  });

  it("binds frontmost verification and a physical Command-S key observer", async () => {
    const appleScript = frontmostProcessAppleScript(123);
    assert.match(appleScript, /application process whose unix id is 123/u);
    assert.match(appleScript, /set frontmost to true/u);
    assert.equal(parseFrontmostPid("123", 123), 123);
    assert.throws(() => parseFrontmostPid("456", 123), /frontmost PID/u);

    const source = physicalCommandSObserverSwiftSource("cd".repeat(16), 10);
    assert.match(source, /addGlobalMonitorForEvents/u);
    assert.match(source, /event\.keyCode == 1/u);
    assert.match(source, /\.command/u);
    assert.match(source, /event\.isARepeat == false/u);
    assert.match(source, /EXCALIDRAW_PHYSICAL_COMMAND_S/u);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-command-s-observer-"),
    );
    try {
      const swiftPath = path.join(root, "observer.swift");
      const moduleCache = path.join(root, "module-cache");
      await fs.writeFile(swiftPath, source);
      const result = spawnSync("xcrun", ["swiftc", "-typecheck", swiftPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: moduleCache,
          SWIFT_MODULECACHE_PATH: moduleCache,
        },
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("validates one owner-approved STOP_REOPEN epoch and rejects identity reuse", () => {
    const binding = nativeBinding({
      proofScope: PROOF_SCOPES.QUALIFICATION,
      remediationEpoch: 1,
      repairTarget: {
        observableSignature:
          "7d16f21de4867f9d056e7b515296822fa4a5e1b0d9fca9c80e690da63dcc6793",
        canonicalIssueId:
          "issue-v1:7cec23a398ea5bc45123e3d0fe2fd415214e13cca31393b6fd94ecc9da1be99e",
      },
      namedChangeSincePreviousAttempt: {
        changeId: "T058g-physical-command-s",
        producer: "native-macos-validation",
        beforeSha256:
          "b70ba803f6ff8b6242b6de1f79e3e5b996fd7a7c70990ee8cfc09668c3e698fc",
        afterSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
      },
      reopenDecision: {
        path: "/tmp/stop-reopen.json",
        relativePath: "../reopen-decisions/T058e-command-s-epoch-1.json",
        sha256: "78".repeat(32),
      },
    });
    const decision = {
      schemaVersion: 1,
      decisionId: "T058e-command-s-epoch-1",
      decisionType: "STOP_REOPEN",
      canonicalIssueId:
        "issue-v1:7cec23a398ea5bc45123e3d0fe2fd415214e13cca31393b6fd94ecc9da1be99e",
      closedRemediationEpoch: 0,
      reopenedRemediationEpoch: 1,
      approvedByRole: "product-owner",
      approvedSpecCommit: "0a1e7573f0a8ce53b169e41a15ca0f7b6904afb0",
      rationaleCode: "PROOF_MECHANISM_REPAIR",
      requiredChange: {
        producer: "native-macos-validation",
        beforeSha256:
          "b70ba803f6ff8b6242b6de1f79e3e5b996fd7a7c70990ee8cfc09668c3e698fc",
        afterSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
      },
      allowedGate: "T023b",
      allowedFactClass: "native-entrypoint-router",
    };
    assert.equal(
      validateStopReopenDecision(
        decision,
        binding,
        NATIVE_VALIDATOR_SOURCE_SHA256,
      ).decisionId,
      decision.decisionId,
    );
    const repaired = buildAttemptRecord(
      buildReport({
        command: "validate",
        checks: [makeCheck("save-keyboard", "physical Command-S", "PASS")],
      }),
      binding,
    );
    assert.equal(
      repaired.observableSignature,
      binding.repairTarget.observableSignature,
    );
    assert.equal(
      repaired.canonicalIssueId,
      binding.repairTarget.canonicalIssueId,
    );
    assert.notEqual(repaired.observedSignature, repaired.observableSignature);
    assert.throws(
      () =>
        validateStopReopenDecision(
          {
            ...decision,
            requiredChange: {
              ...decision.requiredChange,
              beforeSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
            },
          },
          binding,
          NATIVE_VALIDATOR_SOURCE_SHA256,
        ),
      /identity-equivalent/u,
    );
  });

  it("keeps product identity stable across Harness-only commits", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-native-product-identity-"),
    );
    const git = (...args) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    try {
      assert.equal(git("init").status, 0);
      assert.equal(
        git("config", "user.email", "fixture@example.test").status,
        0,
      );
      assert.equal(git("config", "user.name", "Fixture").status, 0);
      await fs.mkdir(path.join(root, "src"));
      await fs.mkdir(path.join(root, "scripts"));
      await fs.mkdir(path.join(root, "docs"));
      await fs.mkdir(path.join(root, "e2e", "visual"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "app.ts"),
        "export const app = 1;\n",
      );
      await fs.writeFile(
        path.join(root, "scripts", "validator.mjs"),
        "export {};\n",
      );
      await fs.writeFile(path.join(root, "docs", "proof.md"), "initial\n");
      await fs.writeFile(
        path.join(root, "e2e", "visual", "003EvidenceOwnership.json"),
        JSON.stringify({ productIdentity: { pathPrefixes: ["src/"] } }),
      );
      assert.equal(git("add", ".").status, 0);
      assert.equal(git("commit", "-m", "initial").status, 0);
      const productCommit = git("rev-parse", "HEAD").stdout.trim();
      const initial = runtimeProductIdentitySha256(root, productCommit);

      await fs.writeFile(
        path.join(root, "scripts", "validator.mjs"),
        "export const v = 2;\n",
      );
      await fs.writeFile(path.join(root, "docs", "proof.md"), "revised\n");
      assert.equal(git("add", ".").status, 0);
      assert.equal(git("commit", "-m", "harness only").status, 0);
      const harnessCommit = git("rev-parse", "HEAD").stdout.trim();
      assert.equal(runtimeProductIdentitySha256(root, harnessCommit), initial);

      await fs.writeFile(
        path.join(root, "src", "app.ts"),
        "export const app = 2;\n",
      );
      assert.equal(git("add", ".").status, 0);
      assert.equal(git("commit", "-m", "runtime").status, 0);
      const runtimeCommit = git("rev-parse", "HEAD").stdout.trim();
      assert.notEqual(
        runtimeProductIdentitySha256(root, runtimeCommit),
        initial,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it(
    "generates AppleScript that compiles before native menu inspection",
    { skip: process.platform !== "darwin" },
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "excalidraw-native-menu-script-"),
      );
      try {
        const scripts = [
          resolveMenuItemAppleScript(123, ["File", "Save"], "click targetItem"),
          inspectMenuItemAppleScript(123, EXPECTED_MENU_ITEMS[0]),
          windowGeometryAppleScript(123),
          completeExportDialogAppleScript(123, "png", "/tmp/out/Test.png"),
          completeExportDialogAppleScript(123, "svg", "/tmp/out/Test.svg"),
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

  it("rejects the observed comma-serialized geometry and parses eight numeric tab fields", () => {
    assert.throws(
      () => parseWindowGeometryOutput("0, 0, 1280, 760, 0, 0, 1280, 760"),
      /eight tab-delimited numeric fields/u,
    );
    assert.deepEqual(
      parseWindowGeometryOutput("12\t34\t900\t700\t0\t0\t1280\t760"),
      {
        launch: { x: 12, y: 34, width: 900, height: 700 },
        requested: { x: 0, y: 0, width: 1280, height: 760 },
      },
    );
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
    const binding = nativeBinding();
    const report = buildReport({
      command: "validate",
      environment: { productVersion: "macOS 26.5.2" },
      manifest: {
        appPath: "/tmp/Excalidraw.app",
        artifactSha256: binding.packageArtifactSha256,
        bundleIdentifier: binding.productIdentity.bundleIdentifier,
        version: binding.productIdentity.version,
      },
      nativeEntrypointProfileSha256: binding.nativeEntrypointProfileSha256,
      checks: [
        makeCheck("native-menu", "menu", "PASS"),
        makeCheck("window-geometry", "geometry", "PASS", {
          observed: parseWindowGeometryOutput(
            "0\t0\t1280\t760\t0\t0\t1280\t760",
          ),
        }),
        makeCheck("state-preparation", "state preparation", "PASS", {
          launchMode: "normal-open-argument",
          path: "/tmp/Architecture.excalidraw",
          sha256Before: "89".repeat(32),
          sha256After: "89".repeat(32),
          byteLength: 128,
        }),
        ...[
          ["save-menu", "save", 1],
          ["save-keyboard", "save", 2],
          ["export-menu", "exportImage", 3],
          ["export-keyboard", "exportImage", 4],
          ["appearance-system", "appearanceSystem", 5],
          ["appearance-light", "appearanceLight", 6],
          ["appearance-dark", "appearanceDark", 7],
        ].map(([id, command, validationId]) =>
          makeCheck(id, id, "PASS", { command, validationId }),
        ),
      ],
    });
    const adapted = adaptNativeValidationReport(report, binding);
    assert.equal(adapted.environment.route, "macos-accessibility");
    assert.deepEqual(
      adapted.routeAcknowledgements.actions.map(
        (action) => action.validationId,
      ),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal("filesystemOutcomes" in adapted, false);
    assert.equal(adapted.routeAcknowledgements.result, "PASS");
    assert.equal(
      adapted.environment.statePreparation.sha256Before,
      adapted.environment.statePreparation.sha256After,
    );
    assert.deepEqual(
      adapted.environment.productIdentity,
      binding.productIdentity,
    );
    assert.deepEqual(
      adapted.environment.validatorIdentity,
      binding.validatorIdentity,
    );
    assert.equal("reviewerVerdict" in adapted.environment, false);
    assert.equal("productOwnerDecision" in adapted.environment, false);

    const qualificationBinding = nativeBinding({
      proofScope: PROOF_SCOPES.QUALIFICATION,
    });
    const qualification = adaptNativeValidationReport(
      {
        ...report,
        checks: report.checks.filter((check) =>
          new Set([
            "native-menu",
            "window-geometry",
            "state-preparation",
            "save-keyboard",
            "save-menu",
          ]).has(check.id),
        ),
      },
      qualificationBinding,
    );
    assert.equal(qualification.routeAcknowledgements.result, "PASS");
    assert.deepEqual(
      qualification.routeAcknowledgements.actions.map(({ checkId }) => checkId),
      ["save-menu", "save-keyboard"],
    );

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
        ).productIdentity.packageArtifactSha256,
        binding.productIdentity.packageArtifactSha256,
      );
      await assert.rejects(
        fs.access(path.join(collection, "filesystem-outcomes.json")),
      );
      const attemptPath = path.join(
        root,
        "attempts",
        binding.attemptIdentity.attemptId,
        "attempt.json",
      );
      const attempt = JSON.parse(await fs.readFile(attemptPath, "utf8"));
      assert.equal(attempt.gate, "T023b");
      assert.equal(attempt.factClass, "native-entrypoint-router");
      assert.equal(attempt.verdict, "PASS");
      assert.equal(attempt.consecutiveFailureCount, 0);
      await assert.rejects(
        writeNativeValidationCollection(collection, report, binding),
        /already exists/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the observed missing Command-S pair without requiring filesystem outcomes", () => {
    const binding = nativeBinding();
    const adapted = adaptNativeValidationReport(
      buildReport({
        command: "validate",
        manifest: {
          artifactSha256: binding.packageArtifactSha256,
          bundleIdentifier: binding.productIdentity.bundleIdentifier,
          version: binding.productIdentity.version,
        },
        nativeEntrypointProfileSha256: binding.nativeEntrypointProfileSha256,
        checks: [
          makeCheck("native-menu", "menu", "PASS"),
          makeCheck("window-geometry", "geometry", "FAIL", {
            observed: {
              launch: { x: null, y: null, width: null, height: null },
              requested: { x: null, y: null, width: null, height: null },
            },
          }),
          makeCheck("save-menu", "save", "PASS", {
            command: "save",
            validationId: 1,
          }),
          makeCheck("save-keyboard", "save", "FAIL", { command: "save" }),
        ],
      }),
      binding,
    );
    assert.equal(adapted.routeAcknowledgements.result, "BLOCKED");
    assert.equal("filesystemOutcomes" in adapted, false);
  });

  it("normalizes failure identity independently of PID, path, timestamp, and wording", () => {
    const binding = nativeBinding({ consecutiveFailureCount: 1 });
    const left = buildAttemptRecord(
      buildReport({
        command: "validate",
        checks: [
          makeCheck("save-keyboard", "save", "FAIL", {
            pid: 123,
            error: "Timed out at /tmp/first",
          }),
        ],
      }),
      binding,
    );
    const right = buildAttemptRecord(
      buildReport({
        command: "validate",
        checks: [
          makeCheck("save-keyboard", "save", "FAIL", {
            pid: 999,
            error: "Different text at /private/tmp/second",
          }),
        ],
      }),
      binding,
    );
    assert.equal(left.observableSignature, right.observableSignature);
    assert.equal(left.canonicalIssueId, right.canonicalIssueId);
    assert.equal(left.consecutiveFailureCount, 2);
    assert.equal(left.nextAction, "REPAIR_HARNESS");
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
      fixture: {
        manifestPath: "/tmp/run/fixture/fixture-manifest.json",
        workspaceRoot: "/tmp/run/fixture/workspace",
      },
      nativeValidation: {
        profileRoot,
        launchDocument: "/tmp/run/fixture/Architecture.excalidraw",
        filesystemTargets: {
          save: "/tmp/run/fixture/Architecture.excalidraw",
          png: "/tmp/run/outcomes/Architecture.png",
          svg: "/tmp/run/outcomes/Architecture.svg",
        },
      },
      screens: [{ gateId: "HF2-01" }],
    };
    const result = validatePreparedNativeProfile(plan, {
      gitCommit: "ab".repeat(20),
      artifactSha256: "ef".repeat(32),
    });
    assert.equal(result.profileRoot, profileRoot);
    assert.equal(
      result.launchDocument,
      "/tmp/run/fixture/Architecture.excalidraw",
    );
    assert.match(result.nativeEntrypointProfileSha256, /^[0-9a-f]{64}$/u);
    assert.equal("filesystemTargets" in result, false);
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
