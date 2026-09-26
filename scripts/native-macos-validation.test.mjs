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
  HISTORY_MENU_READY_TIMEOUT_MS,
  NATIVE_ACTION_STEPS,
  PHYSICAL_COMMAND_S_TIMEOUT_MS,
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
  historyPanelObservationAppleScript,
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
  parseHistoryPanelObservation,
  resolveMenuItemAppleScript,
  runtimeProductIdentitySha256,
  sha256Path,
  physicalCommandSObserverSwiftSource,
  frontmostProcessAppleScript,
  validateStopReopenDecision,
  validatePreparedNativeProfile,
  validationPair,
  VERSION_HISTORY_MENU_ITEM,
  uniqueHistoryTargetFileName,
  waitForHistoryMenuReady,
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

  it("keeps qualification minimal while final preserves the 003 graph and adds history entry inspection", () => {
    assert.equal(PHYSICAL_COMMAND_S_TIMEOUT_MS, 600_000);
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
    assert.equal(nativeMenuItemsForScope(PROOF_SCOPES.FINAL).length, 6);
    assert.deepEqual(
      nativeMenuItemsForScope(PROOF_SCOPES.FINAL).at(-1),
      VERSION_HISTORY_MENU_ITEM,
    );
    assert.deepEqual(nativeActionsForScope(PROOF_SCOPES.HISTORY), []);
    assert.deepEqual(nativeMenuItemsForScope(PROOF_SCOPES.HISTORY), [
      VERSION_HISTORY_MENU_ITEM,
    ]);
  });

  it("waits for the actual History menu enabled state and fails at a bounded deadline", async () => {
    assert.equal(HISTORY_MENU_READY_TIMEOUT_MS, 15_000);
    let time = 0;
    const observed = (enabled) => ({
      label: "Version History…",
      enabled,
      keyboard: { character: "", modifiers: [] },
    });
    let count = 0;
    const ready = await waitForHistoryMenuReady(() => observed(++count >= 3), {
      timeoutMs: 500,
      now: () => time,
      delay: async (ms) => {
        time += ms;
      },
    });
    assert.equal(ready.status, "PASS");
    assert.equal(ready.attempts, 3);
    time = 0;
    const timedOut = await waitForHistoryMenuReady(() => observed(false), {
      timeoutMs: 500,
      now: () => time,
      delay: async (ms) => {
        time += ms;
      },
    });
    assert.equal(timedOut.status, "FAIL");
    assert.equal(timedOut.item.observed.enabled, false);
    const wrongLabel = await waitForHistoryMenuReady(
      () => ({ ...observed(true), label: "History" }),
      { timeoutMs: 500, now: () => 0 },
    );
    assert.equal(wrongLabel.status, "FAIL");
    assert.equal(wrongLabel.attempts, 1);
  });

  it("requires a fixture-unique History filename and a complete AX panel observation", () => {
    const fixtureFiles = [
      { path: "flows/Checkout Flow.excalidraw" },
      { path: "flows/Overview.excalidraw" },
    ];
    const launchDocument = "/tmp/workspace/flows/Checkout Flow.excalidraw";
    assert.equal(
      uniqueHistoryTargetFileName(fixtureFiles, launchDocument),
      "Checkout Flow.excalidraw",
    );
    assert.equal(
      uniqueHistoryTargetFileName(
        [...fixtureFiles, { path: "other/Checkout Flow.excalidraw" }],
        launchDocument,
      ),
      null,
    );
    assert.match(
      historyPanelObservationAppleScript(123, 'a "quoted".excalidraw'),
      /a \\"quoted\\"\.excalidraw/u,
    );
    assert.equal(parseHistoryPanelObservation("1\t1\t1").pass, true);
    assert.equal(parseHistoryPanelObservation("1\t0\t1").pass, false);
    assert.throws(
      () => parseHistoryPanelObservation("1\tbad\t1"),
      NativeValidationBlockedError,
    );
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
    const laterSourceSha256 = "9a".repeat(32);
    const laterBinding = {
      ...binding,
      validatorIdentity: {
        ...binding.validatorIdentity,
        sourceSha256: laterSourceSha256,
      },
      consecutiveFailureCount: 1,
      namedChangeSincePreviousAttempt: {
        changeId: "operator-window-sequencing",
        producer: "native-macos-validation",
        beforeSha256: NATIVE_VALIDATOR_SOURCE_SHA256,
        afterSha256: laterSourceSha256,
      },
    };
    assert.equal(
      validateStopReopenDecision(decision, laterBinding, laterSourceSha256)
        .decisionId,
      decision.decisionId,
    );
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
          inspectMenuItemAppleScript(123, VERSION_HISTORY_MENU_ITEM),
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
    assert.deepEqual(
      parseNativeValidationLine(
        'EXCALIDRAW_NATIVE_MENU_VALIDATION {"stage":"applicationRoute","validationId":8,"command":"versionHistory"}',
      ),
      { stage: "applicationRoute", validationId: 8, command: "versionHistory" },
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
    assert.equal(
      compareMenuObservation(VERSION_HISTORY_MENU_ITEM, {
        label: "Version History…",
        enabled: true,
        keyboard: { character: "", modifiers: 8 },
      }).pass,
      true,
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
        makeCheck(
          "version-history-route",
          "native Version History menu route for the launched document",
          "PASS",
          {
            command: "versionHistory",
            validationId: 8,
            targetDocumentBinding: {
              launchMode: "single-normal-open-argument",
              path: "/tmp/Architecture.excalidraw",
              sha256: "89".repeat(32),
              byteLength: 128,
            },
          },
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
    assert.equal(adapted.versionHistoryEntry.result, "PASS");
    assert.equal(adapted.versionHistoryEntry.action.validationId, 8);
    assert.equal(
      adapted.versionHistoryEntry.targetDocumentBinding.path,
      "/tmp/Architecture.excalidraw",
    );
    const missingTargetBinding = adaptNativeValidationReport(
      {
        ...report,
        checks: report.checks.map((check) =>
          check.id === "version-history-route"
            ? { ...check, targetDocumentBinding: undefined }
            : check,
        ),
      },
      binding,
    );
    assert.equal(missingTargetBinding.versionHistoryEntry.result, "BLOCKED");
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
    assert.equal(qualification.versionHistoryEntry, null);
    assert.deepEqual(
      qualification.routeAcknowledgements.actions.map(({ checkId }) => checkId),
      ["save-menu", "save-keyboard"],
    );

    const historyBinding = nativeBinding({ proofScope: PROOF_SCOPES.HISTORY });
    const historyReport = structuredClone(report);
    historyReport.checks = historyReport.checks.filter((check) =>
      new Set([
        "native-menu",
        "window-geometry",
        "state-preparation",
        "version-history-route",
      ]).has(check.id),
    );
    const historyRoute = historyReport.checks.find(
      (check) => check.id === "version-history-route",
    );
    Object.assign(historyRoute.targetDocumentBinding, {
      observationMethod: "ax-history-panel-filename",
      observedFileName: "Architecture.excalidraw",
      uniqueFileNameInFixture: true,
      panelObservation: {
        headingCount: 1,
        fileNameCount: 1,
        closeCount: 1,
        pass: true,
      },
    });
    const history = adaptNativeValidationReport(historyReport, historyBinding);
    assert.deepEqual(history.routeAcknowledgements.actions, []);
    assert.equal(history.routeAcknowledgements.result, "PASS");
    assert.equal(history.versionHistoryEntry.result, "PASS");
    const launchOnlyReport = structuredClone(historyReport);
    delete launchOnlyReport.checks.find(
      (check) => check.id === "version-history-route",
    ).targetDocumentBinding.observationMethod;
    const launchOnly = adaptNativeValidationReport(
      launchOnlyReport,
      historyBinding,
    );
    assert.equal(launchOnly.versionHistoryEntry.result, "BLOCKED");

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
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(
            path.join(collection, "version-history-entry.json"),
            "utf8",
          ),
        ).targetDocumentBinding,
        report.checks.find((check) => check.id === "version-history-route")
          .targetDocumentBinding,
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

  it("collects an early process-safety BLOCKED report with its verified profile identity", async () => {
    const binding = nativeBinding();
    const report = buildReport({
      command: "validate",
      manifest: {
        artifactSha256: binding.packageArtifactSha256,
        bundleIdentifier: binding.productIdentity.bundleIdentifier,
        version: binding.productIdentity.version,
      },
      checks: [
        makeCheck("disposable-profile", "prepared profile", "PASS", {
          nativeEntrypointProfileSha256: binding.nativeEntrypointProfileSha256,
        }),
        makeCheck("process-safety", "no ambiguous app process", "BLOCKED", {
          processes: ["9395 /tmp/excalidraw-desktop"],
        }),
      ],
    });
    assert.equal(report.nativeEntrypointProfileSha256, undefined);
    assert.equal(report.status, "BLOCKED");

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "excalidraw-native-early-block-"),
    );
    try {
      const collection = path.join(root, "collection");
      const collectorReport = await writeNativeValidationCollection(
        collection,
        report,
        binding,
      );
      assert.equal(collectorReport.result, "BLOCKED");
      assert.equal(collectorReport.claims[0].result, "BLOCKED");
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(collection, "route-acknowledgements.json"),
            "utf8",
          ),
        ).result,
        "BLOCKED",
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(
              root,
              "attempts",
              binding.attemptIdentity.attemptId,
              "attempt.json",
            ),
            "utf8",
          ),
        ).verdict,
        "BLOCKED",
      );
      assert.throws(
        () =>
          adaptNativeValidationReport(
            {
              ...report,
              checks: [
                {
                  ...report.checks[0],
                  nativeEntrypointProfileSha256: "00".repeat(32),
                },
                report.checks[1],
              ],
            },
            binding,
          ),
        /identity does not match/u,
      );
      assert.throws(
        () =>
          adaptNativeValidationReport(
            { ...report, checks: [report.checks[1]] },
            binding,
          ),
        /identity does not match/u,
      );
      assert.throws(
        () =>
          adaptNativeValidationReport(
            { ...report, nativeEntrypointProfileSha256: "00".repeat(32) },
            binding,
          ),
        /identity does not match/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
