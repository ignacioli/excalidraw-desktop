import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { readValidationRoutes } from "./native-menu-check.mjs";

const PREFIX = "EXCALIDRAW_NATIVE_MENU_VALIDATION ";

describe("readValidationRoutes", () => {
  it("parses a record split across stream chunks once it is complete", async () => {
    const stream = new PassThrough();
    const routes = [];
    readValidationRoutes(stream, (route) => routes.push(route));
    const record = `${PREFIX}${JSON.stringify({ stage: "nativeEntry", command: "save" })}`;
    stream.write(`unrelated log line\n${record.slice(0, 40)}`);
    stream.write(`${record.slice(40)}\n${PREFIX}{"stage":"applic`);
    stream.end(`ationRoute","command":"save"}\n`);
    await once(stream, "end");
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(routes, [
      { stage: "nativeEntry", command: "save" },
      { stage: "applicationRoute", command: "save" },
    ]);
  });
});
