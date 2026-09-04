import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  commitRepoFiles,
  commitWorkerWork,
  git,
  onDisk,
  runBranch,
  runBranches,
  throwawayRepo,
} from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

function capturing(): { chunks: string[]; stdout: { write(chunk: string): true } } {
  const chunks: string[] = [];
  return {
    chunks,
    stdout: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function frontier(ids: string[]) {
  return memoryTracker({
    tickets: ids.map((id) => ticket({ id })),
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
}

// What the Worker found in the tree it was handed, which is the only place the
// base is observable from inside a Ticket.
function workerSeeing(
  path: string,
  seen: boolean[],
) {
  return createWorkerAdapter({
    async spawn(request) {
      seen.push(await onDisk(join(request.cwd, path)));
      await commitWorkerWork(request);
      return { exitCode: 0 };
    },
  });
}

test("--base cuts the first Ticket's Branch from the commit it names rather than from the checkout's HEAD", async () => {
  const repo = await throwawayRepo();
  const seen: boolean[] = [];
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await commitRepoFiles(repo.cwd, { "later.txt": "after the base\n" });
    const moved = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: frontier(["52"]),
        worker: workerSeeing("later.txt", seen),
        model: "composer-2",
      }),
      cap: 1,
      base,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(seen, [false]);
    const collected = await runBranch(repo.cwd);
    await git(repo.cwd, ["merge-base", "--is-ancestor", base, collected]);
    await assert.rejects(
      git(repo.cwd, ["merge-base", "--is-ancestor", moved, collected]),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Run that used --base leaves the primary checkout's HEAD exactly where it was", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await commitRepoFiles(repo.cwd, { "later.txt": "after the base\n" });
    const head = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: frontier(["52"]),
        worker: createWorkerAdapter({
          async spawn(request) {
            await commitWorkerWork(request);
            return { exitCode: 0 };
          },
        }),
        model: "composer-2",
      }),
      cap: 1,
      base,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.equal(await git(repo.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(await git(repo.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  } finally {
    await repo.cleanup();
  }
});

test("--base starts a Run from a dirty primary checkout, and the warning that those changes reach no Worktree still stands", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await writeFile(join(repo.cwd, "scratch.txt"), "not committed\n");

    const exitCode = await run({
      config: defineConfig({
        tracker: frontier(["52"]),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      base,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.match(
      out.chunks.join(""),
      /^Warning: uncommitted changes in the primary checkout reach no Worktree$/m,
    );
    assert.equal((await runBranches(repo.cwd)).length, 1);
  } finally {
    await repo.cleanup();
  }
});

test("a --base git cannot resolve fails before any Ticket is claimed, and names the value that failed", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const tracker = frontier(["52"]);
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({ tracker, worker, model: "composer-2" }),
      cap: 1,
      base: "no-such-ref",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    assert.equal(worker.spawns.length, 0);
    assert.deepEqual((await tracker.frontier()).map((item) => item.id), ["52"]);
    assert.match(out.chunks.join(""), /Hard stop: failed at git: .*no-such-ref/);
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("a second Run based on the first Run's Run Branch hands its first Ticket a tree containing the first Run's landed work", async () => {
  const repo = await throwawayRepo();
  const seen: boolean[] = [];
  try {
    const first = await run({
      config: defineConfig({
        tracker: frontier(["52", "57"]),
        worker: createWorkerAdapter({
          async spawn(request) {
            await commitWorkerWork(request);
            return { exitCode: 0 };
          },
        }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(first, 0);
    const landedOn = await runBranch(repo.cwd);

    const second = await run({
      config: defineConfig({
        tracker: frontier(["57"]),
        worker: workerSeeing("ticket-52.txt", seen),
        model: "composer-2",
      }),
      cap: 1,
      base: landedOn,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(second, 0);
    assert.deepEqual(seen, [true]);
  } finally {
    await repo.cleanup();
  }
});
