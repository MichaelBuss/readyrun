import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  commitWorkerWork,
  git,
  runBranches,
  throwawayRepo,
} from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

async function onDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("a Run that lands a Ticket collects it onto one Run Branch cut from the base, and deletes the Ticket's Branch", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52", title: "Fix the thing" })],
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
    const branches = await runBranches(repo.cwd);
    assert.equal(branches.length, 1);
    const runBranch = branches[0] ?? "";
    assert.match(runBranch, /^readyrun\/run-\d{8}-\d{6}$/);
    assert.equal(
      await git(repo.cwd, [
        "rev-list",
        "--first-parent",
        "--count",
        `${base}..${runBranch}`,
      ]),
      "1",
    );
    assert.equal(await git(repo.cwd, ["rev-parse", `${runBranch}^1`]), base);
    assert.equal(
      await git(repo.cwd, ["log", "-1", "--format=%s", runBranch]),
      "Ticket 52: Fix the thing",
    );
    assert.equal(
      await git(repo.cwd, ["log", "-1", "--format=%s", `${runBranch}^2`]),
      "Ticket 52",
    );
    await assert.rejects(
      git(repo.cwd, ["rev-parse", "--verify", "refs/heads/readyrun/52"]),
    );
  } finally {
    await repo.cleanup();
  }
});

test("each Ticket of a Run is one entry on the Run Branch, and the next Ticket starts from a tree holding the work of the ones before it", async () => {
  const repo = await throwawayRepo();
  const sawTicket52WorkAtSpawn: Record<string, boolean> = {};
  const worker = createWorkerAdapter({
    async spawn(request) {
      sawTicket52WorkAtSpawn[request.ticket.id] = await onDisk(
        join(request.cwd, "ticket-52.txt"),
      );
      await commitWorkerWork(request);
      return { exitCode: 0 };
    },
  });
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", title: "Fix the thing" }),
            ticket({ id: "57", title: "Fix the other thing" }),
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

    assert.equal(exitCode, 0);
    assert.deepEqual(sawTicket52WorkAtSpawn, { 52: false, 57: true });
    const runBranch = (await runBranches(repo.cwd))[0] ?? "";
    assert.deepEqual(
      (await git(repo.cwd, [
        "log",
        "--first-parent",
        "--format=%s",
        `${base}..${runBranch}`,
      ])).split("\n"),
      ["Ticket 57: Fix the other thing", "Ticket 52: Fix the thing"],
    );
    for (const id of ["52", "57"]) {
      await assert.rejects(
        git(repo.cwd, ["rev-parse", "--verify", `refs/heads/readyrun/${id}`]),
      );
    }
  } finally {
    await repo.cleanup();
  }
});

test("a Run over an empty Frontier leaves no Run Branch behind", async () => {
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
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("a Run that hard-stops on its first Ticket leaves no Run Branch behind", async () => {
  const repo = await throwawayRepo();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 42 }),
        model: "composer-2",
      }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("a Run that hard-stops on a later Ticket leaves the Run Branch holding the Tickets that already landed", async () => {
  const repo = await throwawayRepo();
  const worker = createWorkerAdapter({
    async spawn(request) {
      if (request.ticket.id === "57") {
        return { exitCode: 42 };
      }
      await commitWorkerWork(request);
      return { exitCode: 0 };
    },
  });
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", title: "Fix the thing" }),
            ticket({ id: "57", title: "Fix the other thing" }),
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

    assert.equal(exitCode, 1);
    const runBranch = (await runBranches(repo.cwd))[0] ?? "";
    assert.deepEqual(
      (await git(repo.cwd, [
        "log",
        "--first-parent",
        "--format=%s",
        `${base}..${runBranch}`,
      ])).split("\n"),
      ["Ticket 52: Fix the thing"],
    );
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/readyrun/57"]);
  } finally {
    await repo.cleanup();
  }
});
