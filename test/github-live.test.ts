import assert from "node:assert/strict";
import { test } from "node:test";
import { github } from "../src/mod.ts";

const live = process.env.READYRUN_GITHUB_LIVE === "1";

test("live credentialed GitHub inspect is opt-in, not required for CI", {
  skip: !live,
}, async () => {
  const repo = process.env.READYRUN_GITHUB_REPO ?? "MichaelBuss/readyrun";
  const adapter = github({
    repo,
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const inspect = await adapter.inspect();
  assert.equal(inspect.repository, repo);
  assert.deepEqual(inspect.selectorLabels, ["ready-for-agent"]);
  assert.ok(
    inspect.existingLabels.includes("ready-for-agent"),
    "expected the live repository to have the ready-for-agent label",
  );
});
