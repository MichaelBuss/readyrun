import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTrackerAdapter, defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitWorkerWork, git, throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

function tracker() {
  return memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
}

function worktreeOf(cwd: string, ticketId: string): string {
  return join(cwd, ".readyrun", "worktrees", `readyrun-${ticketId}`);
}

async function onDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("a verified-successful Ticket's Worktree is gone before the next Ticket starts, and its Branch still carries the work", async () => {
  const repo = await throwawayRepo();
  const ticket52WorktreeAtSpawnOf: Record<string, boolean> = {};
  const worker = createWorkerAdapter({
    async spawn(request) {
      ticket52WorktreeAtSpawnOf[request.ticket.id] = await onDisk(
        worktreeOf(repo.cwd, "52"),
      );
      await commitWorkerWork(request);
      return { exitCode: 0 };
    },
  });
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({ tracker: tracker(), worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(ticket52WorktreeAtSpawnOf, { 52: true, 57: false });
    assert.equal(await onDisk(worktreeOf(repo.cwd, "57")), false);
    assert.equal(
      await git(repo.cwd, ["rev-list", "--count", `${base}..readyrun/52`]),
      "1",
    );
    assert.equal(
      await git(repo.cwd, ["rev-list", "--count", `${base}..readyrun/57`]),
      "1",
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Worker exiting non-zero leaves its Worktree on disk to look at", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 42 });
  try {
    const exitCode = await run({
      config: defineConfig({ tracker: tracker(), worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 1);
    assert.equal(await onDisk(worktreeOf(repo.cwd, "52")), true);
  } finally {
    await repo.cleanup();
  }
});

test("a Worker exiting 0 having committed nothing leaves its Worktree on disk; removal never runs before the success check", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0, work: "none" });
  try {
    const exitCode = await run({
      config: defineConfig({ tracker: tracker(), worker, model: "composer-2" }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 1);
    assert.equal(await onDisk(worktreeOf(repo.cwd, "52")), true);
  } finally {
    await repo.cleanup();
  }
});

test("a Tracker failure finishing a Ticket leaves the Worktree on disk even though the Worker succeeded", async () => {
  const repo = await throwawayRepo();
  const inner = tracker();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: createTrackerAdapter({
          frontier: () => inner.frontier(),
          branchName: (item) => inner.branchName(item),
          leaveFrontier() {
            return Promise.reject(new Error("GitHub API 500"));
          },
        }),
        worker,
        model: "composer-2",
      }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 1);
    assert.equal(await onDisk(worktreeOf(repo.cwd, "52")), true);
  } finally {
    await repo.cleanup();
  }
});

test("re-running a Ticket whose Worktree was kept still hard-stops with WorktreeExistsError", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  try {
    const failed = await run({
      config: defineConfig({
        tracker: tracker(),
        worker: recordingWorker({ exitCode: 42 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(failed, 1);

    const rerun = await run({
      config: defineConfig({
        tracker: tracker(),
        worker: recordingWorker({ exitCode: 0 }),
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

    assert.equal(rerun, 1);
    assert.match(
      chunks.join(""),
      /Hard stop: Ticket 52 failed at git: ReadyRun already has a Worktree for branch readyrun\/52/,
    );
    assert.equal(await onDisk(worktreeOf(repo.cwd, "52")), true);
  } finally {
    await repo.cleanup();
  }
});
