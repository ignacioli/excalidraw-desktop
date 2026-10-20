// Direction B: a pencil drawing the app's own page.
//
// The paper is a plain squircle. The pencil sits inside it, leaning so that the
// line it has just produced runs out of its tip into open space: that line is a
// catenary, the curve a real slack line takes under its own weight.
//
// Usage:
//   node docs/design/app-icon/render-icon-pencil.mjs [--variant bow|catenary|mirror]
//
// `bow` and `mirror` exist only for design comparison; `catenary` is the
// shipped curve.

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = import.meta.dirname;
const VARIANT = process.argv.includes("--variant")
  ? process.argv[process.argv.indexOf("--variant") + 1]
  : "catenary";
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : path.join(HERE, "build", VARIANT);

const SMALL_MAX = 32; // 16 and 32 use the redrawn small master; 48 still reads with the drawn line
const SIZE = 1024;
const INSET = 100;
const ART = SIZE - INSET * 2;
const CENTER = SIZE / 2;

const INK = "#1B1B1F";
const BODY = "#7C77E4";
const WOOD = "#F0DFC3";
const FERRULE = "#C6C3E8";
const ERASER = "#E3A9A9";

const require = createRequire(import.meta.url);
const pnpmDir = path.join(HERE, "../../../node_modules/.pnpm");
const roughDir = (await readdir(pnpmDir))
  .filter((d) => d.startsWith("roughjs@"))
  .sort()
  .pop();
const { generator: RoughGenerator } = require(
  path.join(pnpmDir, roughDir, "node_modules/roughjs/bundled/rough.cjs.js"),
);
const gen = new RoughGenerator();

// ---------------------------------------------------------------- paper

function squircle(radius, n = 5, steps = 240) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    points.push([
      CENTER + radius * Math.sign(c) * Math.abs(c) ** (2 / n),
      CENTER + radius * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  return points;
}

const toPath = (points, close = true) =>
  `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}${close ? "Z" : ""}`;

const PAPER = toPath(squircle(ART / 2));

// ---------------------------------------------------------------- pencil

// Described by width and length rather than by a scale factor, so the small
// sizes can be stubby and bold without also becoming long.
function pencil({
  tip,
  angle,
  halfWidth,
  body,
  detail = true,
  outline = 9,
  tipScale = 1,
}) {
  const w = halfWidth;
  const shoulder = Math.round(w * 1.85);
  const end = shoulder + body;
  const ferrule = detail ? Math.round(w * 0.7) : 0;
  const eraser = detail ? Math.round(w * 0.85) : 0;

  return `<g transform="translate(${tip[0]} ${tip[1]}) rotate(${angle})" stroke="${INK}" stroke-width="${outline}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M${shoulder} ${-w} H${end} V${w} H${shoulder} Z" fill="${BODY}"/>
    ${
      detail
        ? `<path d="M${end} ${-w} H${end + ferrule} V${w} H${end} Z" fill="${FERRULE}"/>
           <path d="M${end + ferrule} ${-w} H${end + ferrule + eraser * 0.4} A${w} ${w} 0 0 1 ${end + ferrule + eraser * 0.4} ${w} H${end + ferrule} Z" fill="${ERASER}"/>
           <path d="M${end} ${-w} V${w} M${end + ferrule} ${-w} V${w}" fill="none"/>`
        : ""
    }
    <path d="M0 0 L${shoulder} ${-w} L${shoulder} ${w} Z" fill="${WOOD}"/>
    <path d="M0 0 L${Math.round(w * 0.5 * tipScale)} ${-Math.round(w * 0.27 * tipScale)} L${Math.round(w * 0.5 * tipScale)} ${Math.round(w * 0.27 * tipScale)} Z" fill="${INK}" stroke-width="${outline * 0.65}"/>
    <path d="M0 0 L${shoulder} ${-w} H${end} V${w} H${shoulder} Z" fill="none"/>
  </g>`;
}

// ---------------------------------------------------------------- stroke

const TIP = [520, 690];
const END = [856, 708];

const LARGE_PENCIL = {
  tip: TIP,
  angle: 250,
  halfWidth: 52,
  body: 324,
  detail: true,
  outline: 9,
};

// Below 48 px the pencil is redrawn: upright, stubby, no eraser or ferrule, no
// outline and no line. Detail at that size is noise, not character; what has to
// survive is the silhouette and the colour order violet / cream / ink.
const SMALL = {
  pencil: {
    tip: [540, 800],
    angle: 265,
    halfWidth: 110,
    body: 360,
    detail: false,
    outline: 16,
    tipScale: 2.2,
  },
};

// A sampled curve handed to the renderer as cubic Béziers. Sampling alone gives
// rough.js a polyline, and it roughens every joint into a visible kink.
function smoothPath(points) {
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)}, ${c2[0].toFixed(2)} ${c2[1].toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

// Catenary fitted to a chord with an exact mid-span sag.
function catenary(p0, p1, sag, steps = 10) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;

  // Solve a * (cosh(length / 2a) - 1) = sag for a.
  let lo = 1;
  let hi = 1e6;
  for (let i = 0; i < 80; i += 1) {
    const a = (lo + hi) / 2;
    const s = a * (Math.cosh(length / (2 * a)) - 1);
    if (s > sag) lo = a;
    else hi = a;
  }
  const a = (lo + hi) / 2;

  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * length;
    const y =
      a * (Math.cosh(length / (2 * a)) - Math.cosh((x - length / 2) / a));
    points.push([p0[0] + ux * x + nx * y, p0[1] + uy * x + ny * y]);
  }
  return smoothPath(points);
}

const STROKE = {
  // Reference: one cubic with a slight, hand-drawn bow.
  bow: "M 520 690 C 640 722, 760 734, 852 716",
  catenary: catenary(TIP, END, 30),
  mirror: catenary(TIP, END, 30),
};

function sketchStroke(d, width) {
  const paths = gen.toPaths(
    gen.path(d, {
      stroke: INK,
      strokeWidth: width,
      roughness: 1.1,
      bowing: 1.2,
      seed: 7,
      fill: "none",
    }),
  );
  return paths
    .filter((p) => p.stroke && p.stroke !== "none")
    .map(
      (p) =>
        `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
}

// ---------------------------------------------------------------- compose

function buildSvg(master) {
  const mark =
    master === "large"
      ? `${sketchStroke(STROKE[VARIANT], 24)}\n  ${pencil(LARGE_PENCIL)}`
      : pencil(SMALL.pencil);
  const mirror =
    master === "large" && VARIANT === "mirror"
      ? ` transform="translate(${SIZE} 0) scale(-1 1)"`
      : "";

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
      <stop offset="1" stop-color="#F8F7F5"/>
    </linearGradient>
  </defs>

  <g opacity="0.15" transform="translate(0 16)"><path d="${PAPER}" fill="#000" filter="url(#soft)"/></g>
  <g opacity="0.10" transform="translate(0 3)"><path d="${PAPER}" fill="#000" filter="url(#tight)"/></g>

  <path d="${PAPER}" fill="url(#sheet)"/>

  <g${mirror}>
  ${mark}
  </g>
</svg>`;
}

// ---------------------------------------------------------------- render

const SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
const ICNS = [
  ["16x16", 16],
  ["16x16@2x", 32],
  ["32x32", 32],
  ["32x32@2x", 64],
  ["128x128", 128],
  ["128x128@2x", 256],
  ["256x256", 256],
  ["256x256@2x", 512],
  ["512x512", 512],
  ["512x512@2x", 1024],
];

const svgFor = { large: buildSvg("large"), small: buildSvg("small") };
const browser = await chromium.launch();

async function render(px, file, master = "large") {
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
const shipped = VARIANT === "catenary";
const masterDir = shipped ? HERE : path.join(HERE, "alternatives");
await mkdir(masterDir, { recursive: true });
await writeFile(
  path.join(masterDir, shipped ? "icon-master.svg" : `${VARIANT}-master.svg`),
  svgFor.large,
);
await writeFile(
  path.join(
    masterDir,
    shipped ? "icon-master-small.svg" : `${VARIANT}-master-small.svg`,
  ),
  svgFor.small,
);

for (const px of SIZES)
  await render(
    px,
    path.join(OUT, `icon-${px}.png`),
    px <= SMALL_MAX ? "small" : "large",
  );

const iconset = path.join(OUT, "icon.iconset");
await mkdir(iconset, { recursive: true });
for (const [slot, px] of ICNS)
  await render(
    px,
    path.join(iconset, `icon_${slot}.png`),
    px <= SMALL_MAX ? "small" : "large",
  );
await run("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  path.join(OUT, "icon.icns"),
]);
await rm(iconset, { recursive: true, force: true });

await browser.close();
console.log(`variant: ${VARIANT}`);
console.log(
  `source: ${shipped ? "icon-master.svg" : `alternatives/${VARIANT}-master.svg`}`,
);
console.log(`renders: ${OUT}`);
