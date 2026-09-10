import assert from "node:assert/strict";
import { test } from "node:test";
import { withVoiceOverActivation } from "./native-voiceover.mjs";

for (const fails of [false, true]) {
  test(`restores VoiceOver after ${fails ? "failure" : "success"}`, async () => {
    let enabled = false;
    const transitions = [];
    const operation = withVoiceOverActivation(
      {
        read: async () => enabled,
        toggle: async () => {
          enabled = !enabled;
          transitions.push(enabled);
        },
        wait: async (expected) => assert.equal(enabled, expected),
        ready: async () => enabled,
      },
      async () => {
        if (fails) throw new Error("state preparation failed");
        return 42;
      },
    );
    if (fails) await assert.rejects(operation, /state preparation failed/);
    else assert.equal(await operation, 42);
    assert.equal(enabled, false);
    assert.deepEqual(transitions, [true, false]);
  });
}
test("preserves an already enabled screen reader", async () => {
  await withVoiceOverActivation(
    {
      read: async () => true,
      toggle: async () => assert.fail("must not toggle existing VoiceOver"),
      wait: async () => assert.fail("must not wait"),
      ready: async () => true,
    },
    async () => {},
  );
});
test("restores when activation does not expose controls", async () => {
  let enabled = false;
  await assert.rejects(
    withVoiceOverActivation(
      {
        read: async () => enabled,
        toggle: async () => {
          enabled = !enabled;
        },
        wait: async () => {},
        ready: async () => false,
      },
      async () => assert.fail("must not perform actions"),
    ),
    /AX controls unavailable/,
  );
  assert.equal(enabled, false);
});
