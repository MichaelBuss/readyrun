import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { createTrackerAdapter, defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitMismatchedNpmLockfile, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);
const silent = { write(_chunk?: string) { return true; } };

test("an empty Frontier is a clean finish distinguished by exit code 0", async () => {
  const repo = await throwawayRepo();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "99", labels: ["other"] })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
  } finally {
    await repo.cleanup();
  }
});

test("hitting the cap is a clean finish distinguished by exit code 0", async () => {
  const repo = await throwawayRepo();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a Worker exiting non-zero hard-stops the Run without skip or retry", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 42 });
  const tracker = memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker,
        worker,
        model: "composer-2",
      }),
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
      (await tracker.frontier()).map((item) => item.id),
      ["52", "57"],
    );
    const output = chunks.join("");
    assert.match(output, /Hard stop: Ticket 52 failed at worker: exit code 42/);
  } finally {
    await repo.cleanup();
  }
});

test("a Tracker API or auth failure hard-stops the Run", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: createTrackerAdapter({
          frontier() {
            return Promise.reject(new Error("401 Unauthorized"));
          },
          branchName(ticket) {
            return `readyrun/${ticket.id}`;
          },
          leaveFrontier() {
            return Promise.resolve();
          },
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
    assert.match(chunks.join(""), /Hard stop: failed at tracker/);
  } finally {
    await repo.cleanup();
  }
});

test("a git failure creating the Branch or Worktree hard-stops the Run; a Worker never runs in the wrong place", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  await exec("git", ["-C", repo.cwd, "branch", "readyrun/52"]);
  const chunks: string[] = [];
  try {
    const exitCode = await run({
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
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(worker.spawns.length, 0);
    assert.match(chunks.join(""), /Hard stop: Ticket 52 failed at git/);
  } finally {
    await repo.cleanup();
  }
});

test("a failed Worktree install hard-stops the Run at git with the install output; a Worker never starts", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  try {
    await commitMismatchedNpmLockfile(repo.cwd);
    const exitCode = await run({
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
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(worker.spawns.length, 0);
    const output = chunks.join("");
    assert.match(output, /Hard stop: Ticket 52 failed at git/);
    assert.match(output, /npm ci/);
    assert.match(output, /in sync|lock file/i);
  } finally {
    await repo.cleanup();
  }
});

test("a missing or unauthenticated Worker at spawn hard-stops the Run", async () => {
  const repo = await throwawayRepo();
  const attempted: string[] = [];
  const worker = createWorkerAdapter({
    spawn(request) {
      attempted.push(request.ticket.id);
      return Promise.reject(new Error("Worker is not logged in"));
    },
  });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
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
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(attempted, ["52"]);
    assert.match(chunks.join(""), /Hard stop: Ticket 52 failed at spawn/);
  } finally {
    await repo.cleanup();
  }
});

test("a Tracker failure finishing a Ticket hard-stops the Run and names that Ticket", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: createTrackerAdapter({
          frontier: () => inner.frontier(),
          branchName: (ticket) => inner.branchName(ticket),
          leaveFrontier() {
            return Promise.reject(new Error("GitHub API 500"));
          },
        }),
        worker,
        model: "composer-2",
      }),
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
    assert.match(chunks.join(""), /Hard stop: Ticket 52 failed at tracker/);
  } finally {
    await repo.cleanup();
  }
});
