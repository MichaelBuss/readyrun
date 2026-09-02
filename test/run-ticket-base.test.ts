import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  commitRepoFiles,
  commitWorkerWork,
  git,
  throwawayRepo,
} from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

test("every Ticket in a Run branches from the base the Run resolved at start, even when the Consumer's checkout moves mid-Run", async () => {
  const repo = await throwawayRepo();
  const worker = createWorkerAdapter({
    async spawn(request) {
      await commitWorkerWork(request);
      await commitRepoFiles(repo.cwd, {
        [`moved-${request.ticket.id}.txt`]: "the Consumer's checkout moved on\n",
      });
      return { exitCode: 0 };
    },
  });
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.notEqual(await git(repo.cwd, ["rev-parse", "HEAD"]), base);
    assert.equal(await git(repo.cwd, ["rev-parse", "readyrun/52^"]), base);
    assert.equal(await git(repo.cwd, ["rev-parse", "readyrun/57^"]), base);
  } finally {
    await repo.cleanup();
  }
});

test("a checkout with no commits to branch from hard-stops the Run at git before a Worker starts", async () => {
  const repo = await throwawayRepo({ commits: false });
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(worker.spawns.length, 0);
    assert.match(chunks.join(""), /Hard stop: failed at git/);
  } finally {
    await repo.cleanup();
  }
});
