#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const HANDOFF_ROOT = path.join(
  REPO_ROOT,
  "docs",
  "design",
  "desktop-shell",
  "hf-2",
);
const MANIFEST_PATH = path.join(HANDOFF_ROOT, "manifest.json");
const DEFAULT_BASELINE_OUTPUT = path.join(
  REPO_ROOT,
  "docs",
  "evidence",
  "003-visual-acceptance",
  "baseline-registry.json",
);
const DEFAULT_CONTACT_SHEET_OUTPUT = path.join(
  REPO_ROOT,
  "docs",
  "evidence",
  "003-visual-acceptance",
  "icon-contact-sheet.png",
);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

export function readPngMetadata(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("not a PNG file");
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG is missing its leading IHDR chunk");
  }
  const colorTypes = new Map([
    [0, "grayscale"],
    [2, "RGB"],
    [3, "indexed"],
    [4, "grayscale-alpha"],
    [6, "RGBA"],
  ]);
  const colorType = buffer.readUInt8(25);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType,
    colorModel: colorTypes.get(colorType) ?? "unknown",
    interlaceMethod: buffer.readUInt8(28),
  };
}

function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn"}): ${(result.stderr ?? result.error ?? "").toString().trim()}`,
    );
  }
  return result.stdout.trim();
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function manifestRelativePath(relativePath) {
  const resolved = path.resolve(HANDOFF_ROOT, relativePath);
  const relative = path.relative(HANDOFF_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`manifest path escapes HF-2 handoff: ${relativePath}`);
  }
  return resolved;
}

export async function verifyHf2Handoff() {
  const manifestBytes = await fs.readFile(MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.status !== "approved" ||
    manifest.penpot?.revisionAtHandoff !== 59 ||
    manifest.approvedAt !== "2026-09-06"
  ) {
    throw new Error(
      "HF-2 manifest is not the product-approved 2026-09-06 revision 59 handoff",
    );
  }

  const screenResults = [];
  for (const expected of manifest.screens ?? []) {
    const filePath = manifestRelativePath(expected.path);
    const bytes = await fs.readFile(filePath);
    const metadata = readPngMetadata(bytes);
    const actualSha256 = sha256(bytes);
    const checks = {
      width: metadata.width === expected.width,
      height: metadata.height === expected.height,
      bitDepth: metadata.bitDepth === 8,
      rgba: metadata.colorType === 6,
      nonInterlaced: metadata.interlaceMethod === 0,
      sha256: actualSha256 === expected.sha256,
    };
    screenResults.push({
      name: expected.name,
      boardId: expected.boardId,
      path: path.relative(REPO_ROOT, filePath),
      expected: {
        width: expected.width,
        height: expected.height,
        bitDepth: 8,
        colorModel: "RGBA",
        interlaceMethod: 0,
        sha256: expected.sha256,
      },
      actual: { ...metadata, sha256: actualSha256 },
      checks,
      result: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    });
  }

  const iconResults = [];
  for (const expected of manifest.icons ?? []) {
    const filePath = manifestRelativePath(expected.path);
    const actualSha256 = await sha256File(filePath);
    const xml = spawnSync("xmllint", ["--noout", filePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const checks = {
      sha256: actualSha256 === expected.sha256,
      xml: xml.status === 0,
    };
    iconResults.push({
      name: expected.name,
      shapeId: expected.shapeId,
      path: path.relative(REPO_ROOT, filePath),
      expectedSha256: expected.sha256,
      actualSha256,
      checks,
      result: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    });
  }

  const designBaselineCommit = runRequired("git", [
    "log",
    "-1",
    "--format=%H",
    "--",
    path.relative(REPO_ROOT, MANIFEST_PATH),
  ]);
  const screenPassCount = screenResults.filter(
    ({ result }) => result === "PASS",
  ).length;
  const iconPassCount = iconResults.filter(
    ({ result }) => result === "PASS",
  ).length;
  const result =
    screenPassCount === screenResults.length &&
    iconPassCount === iconResults.length &&
    screenResults.length === 6 &&
    iconResults.length === 10
      ? "PASS"
      : "FAIL";

  return {
    schemaVersion: 2,
    tasks: ["T008", "T009"],
    generatedAt: new Date().toISOString(),
    result,
    authority: {
      handoffReadme: "docs/design/desktop-shell/hf-2/README.md",
      manifestPath: path.relative(REPO_ROOT, MANIFEST_PATH),
      manifestSha256: sha256(manifestBytes),
      status: manifest.status,
      approvedAt: manifest.approvedAt,
      penpotFileId: manifest.penpot.fileId,
      penpotRevision: manifest.penpot.revisionAtHandoff,
      designBaselineCommit,
    },
    screens: screenResults,
    icons: iconResults,
    summary: {
      expectedScreenCount: 6,
      actualScreenCount: screenResults.length,
      screenPassCount,
      expectedIconCount: 10,
      actualIconCount: iconResults.length,
      iconPassCount,
      result,
    },
  };
}

function baselineRegistry(report) {
  return {
    schemaVersion: 2,
    task: "T008",
    generatedAt: report.generatedAt,
    result: report.result,
    authority: report.authority,
    expectedScreenDimensions: { width: 1280, height: 760 },
    results: report.screens,
    summary: {
      screenCount: report.summary.actualScreenCount,
      passCount: report.summary.screenPassCount,
      failCount:
        report.summary.actualScreenCount - report.summary.screenPassCount,
      result:
        report.summary.actualScreenCount === 6 &&
        report.summary.screenPassCount === 6
          ? "PASS"
          : "FAIL",
    },
  };
}

async function renderContactSheet(report, outputPath) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-hf2-icon-sheet-"),
  );
  try {
    const tiles = [];
    for (const [index, icon] of report.icons.entries()) {
      const sourcePath = path.join(REPO_ROOT, icon.path);
      const source = await fs.readFile(sourcePath, "utf8");
      const renderSource = source
        .replace('width="16"', 'width="128"')
        .replace('height="16"', 'height="128"');
      if (renderSource === source) {
        throw new Error(`cannot prepare 128px render wrapper for ${icon.path}`);
      }
      const renderSourcePath = path.join(
        tempRoot,
        `${index}-${path.basename(sourcePath)}`,
      );
      await fs.writeFile(renderSourcePath, renderSource, "utf8");
      runRequired("qlmanage", [
        "-t",
        "-s",
        "128",
        "-o",
        tempRoot,
        renderSourcePath,
      ]);
      const thumbnailPath = path.join(
        tempRoot,
        `${path.basename(renderSourcePath)}.png`,
      );
      const tilePath = path.join(tempRoot, `tile-${index}.png`);
      runRequired("magick", [
        thumbnailPath,
        "-fuzz",
        "5%",
        "-trim",
        "+repage",
        "-resize",
        "72x72",
        "-background",
        "white",
        "-alpha",
        "remove",
        "-alpha",
        "off",
        "-gravity",
        "center",
        "-extent",
        "192x192",
        tilePath,
      ]);
      tiles.push(tilePath);
    }
    const firstRowPath = path.join(tempRoot, "row-1.png");
    const secondRowPath = path.join(tempRoot, "row-2.png");
    runRequired("magick", [...tiles.slice(0, 5), "+append", firstRowPath]);
    runRequired("magick", [...tiles.slice(5), "+append", secondRowPath]);
    runRequired("magick", [
      firstRowPath,
      secondRowPath,
      "-append",
      "-strip",
      "-define",
      "png:exclude-chunk=date,time",
      outputPath,
    ]);
    return {
      path: path.relative(REPO_ROOT, outputPath),
      width: 960,
      height: 384,
      sha256: await sha256File(outputPath),
      renderer:
        "macOS Quick Look rendered each validated SVG independently through a temporary 128px wrapper; ImageMagick only trimmed, normalized, and assembled the fixed-order grid",
      tileOrder: report.icons.map(({ name, path: iconPath, actualSha256 }) => ({
        name,
        path: iconPath,
        sha256: actualSha256,
      })),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/verify-hf2-handoff.mjs [--check-only] [--baseline-output PATH] [--contact-sheet-output PATH]",
    );
    return;
  }
  const report = await verifyHf2Handoff();
  if (!args.includes("--check-only") && report.result === "PASS") {
    const baselineOutput = path.resolve(
      optionValue(args, "--baseline-output") ?? DEFAULT_BASELINE_OUTPUT,
    );
    const contactSheetOutput = path.resolve(
      optionValue(args, "--contact-sheet-output") ??
        DEFAULT_CONTACT_SHEET_OUTPUT,
    );
    report.contactSheet = await renderContactSheet(report, contactSheetOutput);
    await writeJson(baselineOutput, baselineRegistry(report));
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
