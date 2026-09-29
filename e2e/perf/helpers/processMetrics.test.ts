import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { collectPerformanceBinaryIdentity } from "./processMetrics";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("records the canonical executable and its exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "performance-binary-"));
  temporaryRoots.push(root);
  const executable = join(root, "excalidraw-desktop");
  const alias = join(root, "binary-alias");
  const bytes = Buffer.from("test-only executable bytes");
  await writeFile(executable, bytes);
  await symlink(executable, alias);

  const identity = await collectPerformanceBinaryIdentity(alias);

  expect(identity).toEqual({
    path: await realpath(executable),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "e2e-harness",
    pathScope: "absolute",
  });
});

test("fails when the executable cannot be read", async () => {
  await expect(
    collectPerformanceBinaryIdentity(
      join(tmpdir(), "missing-performance-binary"),
    ),
  ).rejects.toThrow();
});
