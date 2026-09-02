import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { git, runBranches, throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

function tracker() {
  return memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
}

test("a Worker exiting 0 with a dirty Worktree hard-stops the Run and leaves its Ticket on the Frontier", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0, work: "uncommitted" });
  const frontier = tracker();
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({ tracker: frontier, worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52"]);
    assert.deepEqual(
      (await frontier.frontier()).map((item) => item.id),
      ["52", "57"],
    );
    assert.match(
      chunks.join(""),
      /Hard stop: Ticket 52 failed at worker: left work uncommitted in .*readyrun-52/,
    );
    const worktree = worker.spawns[0]?.cwd;
    assert.ok(worktree);
    await access(join(worktree, "ticket-52.txt"));
  } finally {
    await repo.cleanup();
  }
});

test("a Worker exiting 0 having committed nothing hard-stops the Run and leaves its Ticket on the Frontier", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0, work: "none" });
  const frontier = tracker();
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({ tracker: frontier, worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52"]);
    assert.deepEqual(
      (await frontier.frontier()).map((item) => item.id),
      ["52", "57"],
    );
    assert.match(
      chunks.join(""),
      /Hard stop: Ticket 52 failed at worker: committed nothing on readyrun\/52/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Worker exiting 0 with a clean Worktree and a commit on its Branch takes its Ticket off the Frontier", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0, work: "committed" });
  const frontier = tracker();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({ tracker: frontier, worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "57"]);
    assert.deepEqual(await frontier.frontier(), []);
    const runBranch = (await runBranches(repo.cwd))[0] ?? "";
    assert.equal(
      await git(repo.cwd, [
        "rev-list",
        "--first-parent",
        "--count",
        `${base}..${runBranch}`,
      ]),
      "2",
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Worker that commits on another Branch leaves its own Branch empty and hard-stops the Run", async () => {
  const repo = await throwawayRepo();
  const worker = createWorkerAdapter({
    async spawn(request) {
      await git(request.cwd, ["checkout", "-b", "somewhere-else"]);
      await writeFile(
        join(request.cwd, "elsewhere.txt"),
        "not on the Ticket's Branch\n",
      );
      await git(request.cwd, ["add", "--", "elsewhere.txt"]);
      await git(request.cwd, ["commit", "-m", "elsewhere"]);
      return { exitCode: 0 };
    },
  });
  const frontier = tracker();
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({ tracker: frontier, worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(
      (await frontier.frontier()).map((item) => item.id),
      ["52", "57"],
    );
    assert.match(
      chunks.join(""),
      /Hard stop: Ticket 52 failed at worker: committed nothing on readyrun\/52/,
    );
  } finally {
    await repo.cleanup();
  }
});
