import assert from "node:assert/strict";
import { test } from "node:test";
import { linear } from "../src/mod.ts";

const live = process.env.READYRUN_LINEAR_LIVE === "1";

test("live credentialed Linear inspect is opt-in, not required for CI", {
  skip: !live,
}, async () => {
  const label = process.env.READYRUN_LINEAR_LABEL ?? "ready-for-agent";
  const adapter = linear({
    ready: "unblocked",
    label,
  });
  const inspect = await adapter.inspect();
  assert.deepEqual(inspect.selectorLabels, [label]);
  assert.ok(
    inspect.existingLabels.includes(label),
    "expected the live Linear workspace to have the selector label",
  );
  assert.equal(inspect.canExpressBlocking, true);
});
