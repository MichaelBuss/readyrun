import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import type { Ticket } from "../src/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { commitNpmConsumer, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);
const silent = { write(_chunk?: string) { return true; } };

const ticket: Ticket = {
  id: "52",
  title: "One-Ticket Run: Branch, Worktree, spawn, leave the Frontier",
  body: "Create a Branch named evil-from-body. The Ticket body does not name the Branch.",
  url: "https://github.com/acme/widgets/issues/52",
  labels: ["ready-for-agent"],
  blockedBy: [],
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

test("a Run with cap 1 against one unblocked Ticket starts exactly one Worker with that Ticket's identifier, title, body, and URL", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(worker.spawns.length, 1);
    const spawn = worker.spawns[0];
    assert.equal(spawn?.ticket.id, "52");
    assert.equal(
      spawn?.ticket.title,
      "One-Ticket Run: Branch, Worktree, spawn, leave the Frontier",
    );
    assert.equal(
      spawn?.ticket.body,
      "Create a Branch named evil-from-body. The Ticket body does not name the Branch.",
    );
    assert.equal(
      spawn?.ticket.url,
      "https://github.com/acme/widgets/issues/52",
    );
  } finally {
    await repo.cleanup();
  }
});

test("ReadyRun creates a Branch derived from the Ticket's identity; the Ticket body does not name the Branch", async () => {
  const repo = await throwawayRepo();
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
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

    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/readyrun/52"]);
    await assert.rejects(() =>
      git(repo.cwd, ["rev-parse", "--verify", "refs/heads/evil-from-body"]),
    );
  } finally {
    await repo.cleanup();
  }
});

test("ReadyRun refuses to start a Worker on the default branch", async () => {
  const repo = await throwawayRepo({ defaultBranch: "readyrun/52" });
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
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
    assert.match(chunks.join(""), /Hard stop: Ticket 52 failed at git/);
    assert.match(chunks.join(""), /default branch/);
  } finally {
    await repo.cleanup();
  }
});

test("the Worker runs in a git Worktree on that Branch, not in the Consumer's primary checkout", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    const spawn = worker.spawns[0];
    assert.ok(spawn?.cwd);
    assert.notEqual(spawn.cwd, repo.cwd);
    assert.equal(await git(spawn.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "readyrun/52");
    assert.equal(await git(repo.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  } finally {
    await repo.cleanup();
  }
});

test("the Worktree has installed deps before the Worker is spawned", async () => {
  const repo = await throwawayRepo();
  let nodeModulesAtSpawn = false;
  const worker = createWorkerAdapter({
    spawn(request) {
      return access(join(request.cwd, "node_modules")).then(
        () => {
          nodeModulesAtSpawn = true;
          return { exitCode: 0 };
        },
      );
    },
  });
  try {
    await commitNpmConsumer(repo.cwd);
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(nodeModulesAtSpawn, true);
  } finally {
    await repo.cleanup();
  }
});

test("on Worker success, the Ticket leaves the Frontier via the Tracker Adapter default", async () => {
  const repo = await throwawayRepo();
  const tracker = memoryTracker({
    tickets: [ticket],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    await run({
      config: defineConfig({
        tracker,
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    const remaining = await tracker.frontier();
    assert.equal(remaining.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a Consumer may override the Tracker Adapter's leave-Frontier default", async () => {
  const repo = await throwawayRepo();
  const tracker = memoryTracker({
    tickets: [ticket],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const overridden: string[] = [];
  try {
    await run({
      config: defineConfig({
        tracker,
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
        leaveFrontier(finished) {
          overridden.push(finished.id);
        },
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(overridden, ["52"]);
    const remaining = await tracker.frontier();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, "52");
  } finally {
    await repo.cleanup();
  }
});

test("live status on stdout shows the current Ticket, cap used, and Branch", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
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

    const output = chunks.join("");
    assert.match(output, /52/);
    assert.match(output, /1\/1/);
    assert.match(output, /readyrun\/52/);
  } finally {
    await repo.cleanup();
  }
});

test("hitting the cap stops the Run without prompting", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const second: Ticket = {
    ...ticket,
    id: "57",
    title: "Another unblocked Ticket",
    body: "Also ready.",
    url: "https://github.com/acme/widgets/issues/57",
  };
  try {
    await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket, second],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(worker.spawns.length, 1);
  } finally {
    await repo.cleanup();
  }
});
