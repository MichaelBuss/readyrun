import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitWorkerWork, git, throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

test("a blocked Ticket is never picked, even if it matches the selector", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", labels: ["other"] }),
            ticket({ id: "53", blockedBy: ["52"] }),
          ],
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

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), []);
  } finally {
    await repo.cleanup();
  }
});

test("the Consumer selector filters which Tickets a Run picks", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", labels: ["ready-for-agent"] }),
            ticket({ id: "99", labels: ["other"] }),
          ],
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

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52"]);
  } finally {
    await repo.cleanup();
  }
});

test("an optional parent root narrows a Run to that parent's children", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "11", parent: "8" }),
            ticket({ id: "12", parent: "9" }),
            ticket({ id: "8" }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
          parent: "8",
        }),
        worker,
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["11"]);
  } finally {
    await repo.cleanup();
  }
});

test("an optional ids root narrows a Run to that explicit list of Ticket ids", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52" }),
            ticket({ id: "53" }),
            ticket({ id: "57" }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
          ids: ["52", "57"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "57"]);
  } finally {
    await repo.cleanup();
  }
});

test("pick order is the adapter's stable ascending identifier order", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "57" }), ticket({ id: "52" })],
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

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "57"]);
  } finally {
    await repo.cleanup();
  }
});

test("the Frontier is recomputed after each Ticket so newly unblocked work is eligible in the same Run", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52" }),
            ticket({ id: "53", blockedBy: ["52"] }),
          ],
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

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "53"]);
  } finally {
    await repo.cleanup();
  }
});

test("an empty Frontier stops the Run as a clean finish, not an error", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "99", labels: ["other"] })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a v0 Run starts one Worker at a time; each Ticket still gets its own Branch and Worktree", async () => {
  const repo = await throwawayRepo();
  let inFlight = 0;
  let maxInFlight = 0;
  const worktreesAtSpawn: Record<string, string> = {};
  const worker = createWorkerAdapter({
    async spawn(request) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      worktreesAtSpawn[request.ticket.id] = await git(repo.cwd, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      inFlight -= 1;
      await commitWorkerWork(request);
      return { exitCode: 0 };
    },
  });
  try {
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

    assert.equal(maxInFlight, 1);
    assert.match(worktreesAtSpawn["52"] ?? "", /readyrun\/52/);
    assert.match(worktreesAtSpawn["57"] ?? "", /readyrun\/57/);
    assert.equal(await git(repo.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  } finally {
    await repo.cleanup();
  }
});

test("the Worker is given one Ticket, never a tree", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "8" }),
            ticket({ id: "11", parent: "8" }),
            ticket({ id: "12", parent: "8" }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
          parent: "8",
        }),
        worker,
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["11", "12"]);
  } finally {
    await repo.cleanup();
  }
});
