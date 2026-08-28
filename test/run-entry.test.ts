import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, run, RunCapRequiredError } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

function consumerConfig(overrides: { cap?: number } = {}) {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [
        {
          id: "52",
          title: "Package, defineConfig, and the test seam",
          body: "Establish the public config surface.",
          url: "https://github.com/acme/widgets/issues/52",
          labels: ["ready-for-agent"],
          blockedBy: [],
        },
        {
          id: "53",
          title: "Blocked until 52 lands",
          body: "Depends on the package surface.",
          url: "https://github.com/acme/widgets/issues/53",
          labels: ["ready-for-agent"],
          blockedBy: ["52"],
        },
      ],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
    ...overrides,
  });
}

test("tests assemble config with a fake Tracker Adapter and fake Worker Adapter and invoke the same entry the CLI will use", async () => {
  const repo = await throwawayRepo();
  try {
    await run({ config: consumerConfig(), cap: 1, cwd: repo.cwd, stdout: silent });
  } finally {
    await repo.cleanup();
  }
});

test("a Run without a cap is refused", async () => {
  await assert.rejects(
    () => run({ config: consumerConfig() }),
    (error: unknown) => {
      assert.ok(error instanceof RunCapRequiredError);
      assert.match(error.message, /A Run cannot start without a cap/);
      return true;
    },
  );
});

test("a Run accepts a cap supplied in config", async () => {
  const repo = await throwawayRepo();
  try {
    await run({ config: consumerConfig({ cap: 1 }), cwd: repo.cwd, stdout: silent });
  } finally {
    await repo.cleanup();
  }
});
