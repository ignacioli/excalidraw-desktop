// Excalidraw Desktop app icon source.
//
// Direction A: paper squircle + one hand-drawn mark. The mark is generated with
// rough.js, the same sketch engine the Excalidraw canvas uses, so the icon is
// drawn in the product's own visual language rather than an imitation of it.
//
// Every size is rendered from the vector source; nothing is upscaled. A second
// master with a heavier stroke is used for 16 and 32 px, where a 30 px stroke
// would thin out to a grey hairline.
//
// Usage: node docs/design/app-icon/render-icon.mjs [--out <dir>]

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = import.meta.dirname;
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : path.join(HERE, "build");

// ---------------------------------------------------------------- palette

const SIZE = 1024;
const INSET = 100; // macOS icon grid: 824 x 824 artwork inside a 1024 canvas
const ART = SIZE - INSET * 2;
const CENTER = SIZE / 2;

const INK = "#1B1B1F";
const SHAPE_FILL = "#C5C1FF";

// rough.js ships inside the locked Excalidraw dependency tree; reuse that copy
// instead of adding a second one.
const require = createRequire(import.meta.url);
const pnpmDir = path.join(HERE, "../../../node_modules/.pnpm");
const roughDir = (await readdir(pnpmDir))
  .filter((d) => d.startsWith("roughjs@"))
  .sort()
  .pop();
const { generator: RoughGenerator } = require(
  path.join(pnpmDir, roughDir, "node_modules/roughjs/bundled/rough.cjs.js"),
);

// ---------------------------------------------------------------- geometry

// Superellipse (n = 5): straight sides with continuous corner curvature, which
// is what makes it sit correctly beside macOS system icons.
function squirclePath(size, n = 5, steps = 240) {
  const a = size / 2;
  const points = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    points.push([
      CENTER + a * Math.sign(c) * Math.abs(c) ** (2 / n),
      CENTER + a * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
}

// Four corners that are neither square nor aligned: the mark reads as drawn.
const MARK = [
  [484, 216],
  [791, 458],
  [555, 803],
  [228, 539],
];

// Large sizes: confident line, low roughness, slight bow. Small sizes: heavier
// stroke and less wobble, because the wobble turns into noise below ~48 px.
const MASTERS = {
  large: { strokeWidth: 20, roughness: 1.35, bowing: 1.6, seed: 13 },
  small: { strokeWidth: 44, roughness: 0.6, bowing: 0.7, seed: 13 },
};

// ---------------------------------------------------------------- drawing

const gen = new RoughGenerator();

function roughPolygon(points, options) {
  const d = `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
  return gen.toPaths(gen.path(d, { fill: "none", ...options }));
}

// Two decimals is below one device pixel at 1024 and keeps the source readable.
const round = (d) => d.replace(/-?\d+\.\d+/g, (n) => Number(n).toFixed(2));

function renderPaths(paths) {
  return paths
    .map((p) =>
      p.fill && p.fill !== "none"
        ? `<path d="${round(p.d)}" fill="${p.fill}" stroke="none"/>`
        : `<path d="${round(p.d)}" fill="none" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
}

function buildSvg(sketch) {
  const sq = squirclePath(ART);
  const mark = renderPaths(
    roughPolygon(MARK, {
      ...sketch,
      stroke: INK,
      fill: SHAPE_FILL,
      fillStyle: "solid",
    }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <filter id="soft" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <filter id="tight" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
    <linearGradient id="sheet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#F7F6F4"/>
    </linearGradient>
  </defs>

  <g opacity="0.15" transform="translate(0 16)"><path d="${sq}" fill="#000" filter="url(#soft)"/></g>
  <g opacity="0.10" transform="translate(0 3)"><path d="${sq}" fill="#000" filter="url(#tight)"/></g>

  <path d="${sq}" fill="url(#sheet)"/>
  <path d="${sq}" fill="none" stroke="rgba(27,27,31,0.08)" stroke-width="2"/>

  ${mark}
</svg>`;
}

// ---------------------------------------------------------------- render

const SIZES_LARGE = [1024, 512, 256, 128, 64, 48];
const SIZES_SMALL = [32, 16];

// macOS icon.icns slots and the master each is drawn from.
const ICNS = [
  ["16x16", 16, "small"],
  ["16x16@2x", 32, "small"],
  ["32x32", 32, "small"],
  ["32x32@2x", 64, "large"],
  ["128x128", 128, "large"],
  ["128x128@2x", 256, "large"],
  ["256x256", 256, "large"],
  ["256x256@2x", 512, "large"],
  ["512x512", 512, "large"],
  ["512x512@2x", 1024, "large"],
];

const svgFor = {
  large: buildSvg(MASTERS.large),
  small: buildSvg(MASTERS.small),
};
const browser = await chromium.launch();

async function renderPng(master, px, file) {
  const page = await browser.newPage({
    viewport: { width: px, height: px },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${svgFor[master]}`,
  );
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await writeFile(path.join(HERE, "icon-master.svg"), svgFor.large);
await writeFile(path.join(HERE, "icon-master-small.svg"), svgFor.small);

for (const px of SIZES_LARGE)
  await renderPng("large", px, path.join(OUT, `icon-${px}.png`));
for (const px of SIZES_SMALL)
  await renderPng("small", px, path.join(OUT, `icon-${px}.png`));

// icon.icns, assembled from the same renders rather than from one bitmap.
const iconset = path.join(OUT, "icon.iconset");
await mkdir(iconset, { recursive: true });
for (const [slot, px, master] of ICNS) {
  await renderPng(master, px, path.join(iconset, `icon_${slot}.png`));
}
await run("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  path.join(OUT, "icon.icns"),
]);
await rm(iconset, { recursive: true, force: true });

await browser.close();
console.log(`sources: icon-master.svg, icon-master-small.svg`);
console.log(`renders: ${OUT}`);
