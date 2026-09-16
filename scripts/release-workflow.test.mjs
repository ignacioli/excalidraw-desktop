import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";

const source = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const cutSource = readFileSync(
  new URL("../.github/workflows/cut-release.yml", import.meta.url),
  "utf8",
);

function expression(block, key, indent) {
  const line = block
    .split("\n")
    .find((candidate) => candidate.startsWith(`${" ".repeat(indent)}${key}: `));
  assert.ok(line, `missing ${key} at indentation ${indent}`);
  const value = line.slice(indent + key.length + 2);
  return value.startsWith("${{ ") && value.endsWith(" }}")
    ? value.slice(4, -3)
    : value;
}

function job(name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing job ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-z][\w-]*:$/m);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function evaluate(
  expr,
  { event = "push", ref = "refs/heads/main", tag = "" } = {},
) {
  // Only evaluate the narrow, trusted GitHub expression subset used by this
  // workflow. This is a source-contract check, not a GitHub Actions emulator.
  assert.match(expr, /^(?:[\w.\s'!|&=(),/-])+$/);
  return new Script(expr).runInNewContext({
    github: { event_name: event, ref, ref_name: ref.split("/").at(-1) },
    inputs: { tag },
    startsWith: (value, prefix) => String(value).startsWith(prefix),
  });
}

test("publish gate accepts a reusable call from main and tag runs, but not manual main dispatch", () => {
  const gate = expression(job("publish-github-release"), "if", 4);
  assert.equal(
    gate,
    "inputs.tag != '' || startsWith(github.ref, 'refs/tags/v')",
  );
  assert.equal(evaluate(gate, { event: "push", tag: "v0.3.0" }), true);
  assert.equal(evaluate(gate, { ref: "refs/tags/v0.3.0" }), true);
  assert.equal(
    evaluate(gate, { event: "workflow_dispatch", ref: "refs/tags/v0.3.0" }),
    true,
  );
  assert.equal(evaluate(gate, { event: "workflow_dispatch" }), false);
  assert.equal(evaluate(gate), false);
});

test("release tag and concurrency prefer explicit tag input over caller ref", () => {
  const concurrency = expression(source, "group", 2);
  const releaseTag = expression(
    job("publish-github-release"),
    "RELEASE_TAG",
    6,
  );
  assert.equal(concurrency, "release-${{ inputs.tag || github.ref }}");
  assert.equal(releaseTag, "inputs.tag || github.ref_name");
  assert.equal(
    evaluate(concurrency.slice("release-${{ ".length, -3), { tag: "v0.3.0" }),
    "v0.3.0",
  );
  assert.equal(evaluate(releaseTag, { tag: "v0.3.0" }), "v0.3.0");
  assert.equal(evaluate(releaseTag, { ref: "refs/tags/v0.3.0" }), "v0.3.0");
});

test("all build and publish jobs check out the tag input or event ref", () => {
  for (const name of [
    "macos-universal",
    "linux-bundles",
    "publish-github-release",
  ]) {
    const checkout = job(name).match(
      /      - name: Check out the tagged source\n        uses: actions\/checkout@v\d+\n        with:\n          ref: \$\{\{ ([^\n]+) \}\}/g,
    );
    assert.equal(
      checkout?.length,
      1,
      `${name} must bind exactly one tagged checkout`,
    );
    assert.match(checkout[0], /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
  }
});

test("manual dispatch accepts an optional existing tag input", () => {
  assert.match(
    source,
    /^  workflow_dispatch:\n    inputs:\n      tag:\n(?:        [^\n]+\n)*?        required: false\n        type: string$/m,
  );
  assert.match(
    source,
    /^  workflow_call:\n    inputs:\n      tag:\n(?:        [^\n]+\n)*?        required: true\n        type: string$/m,
  );
});

test("a preflight checks version shape, ref identity, and remote tag existence", () => {
  const preflight = job("validate-release-tag");
  assert.equal(
    expression(preflight, "RELEASE_TAG", 10),
    "inputs.tag || github.ref_name",
  );
  assert.match(
    preflight,
    /\[\[ ! "\$RELEASE_TAG" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/,
  );
  assert.match(
    preflight,
    /\[\[ "\$GITHUB_REF" == refs\/tags\/\* && "\$\{GITHUB_REF#refs\/tags\/\}" != "\$RELEASE_TAG" \]\]/,
  );
  assert.match(
    preflight,
    /git ls-remote --exit-code --tags origin "refs\/tags\/\$RELEASE_TAG"/,
  );
  for (const name of ["macos-universal", "linux-bundles"]) {
    assert.equal(expression(job(name), "needs", 4), "validate-release-tag");
  }
  assert.equal(
    expression(job("publish-github-release"), "needs", 4),
    "[validate-release-tag, macos-universal, linux-bundles]",
  );
});

test("publishing verifies the tag; cut-release forwards the newly created tag", () => {
  assert.match(
    job("publish-github-release"),
    /gh release create "\$RELEASE_TAG"\n(?:          --[^\n]+\n)*          --verify-tag\n/,
  );
  assert.match(
    cutSource,
    /^  release:\n(?:    [^\n]+\n)*?    uses: \.\/\.github\/workflows\/release\.yml\n    with:\n      tag: \$\{\{ needs\.cut\.outputs\.tag \}\}$/m,
  );
});
