import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTrackerAdapter,
  defineConfig,
  doctor,
  run,
} from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import type { TrackerAdapter } from "../src/mod.ts";
import { createWorkerAdapter, type WorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

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

function output(chunks: string[]): string {
  return chunks.join("");
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

function delayTracker(
  inner: TrackerAdapter,
  delays: {
    inspect?: { wait: Promise<void>; onStart: () => void };
    frontier?: { wait: Promise<void>; onStart: () => void };
  },
): TrackerAdapter {
  return createTrackerAdapter({
    async frontier() {
      if (delays.frontier !== undefined) {
        delays.frontier.onStart();
        await delays.frontier.wait;
      }
      return inner.frontier();
    },
    branchName: (item) => inner.branchName(item),
    leaveFrontier: (item, landing) => inner.leaveFrontier(item, landing),
    promptCopy: (item) => inner.promptCopy(item),
    async inspect() {
      if (delays.inspect !== undefined) {
        delays.inspect.onStart();
        await delays.inspect.wait;
      }
      return inner.inspect();
    },
  });
}

function delaySpawn(
  inner: WorkerAdapter,
  wait: Promise<void>,
  onStart: () => void,
): WorkerAdapter {
  return createWorkerAdapter({
    effortFlag: inner.effortFlag,
    async spawn(request) {
      onStart();
      await wait;
      return inner.spawn(request);
    },
  });
}

test("a Run writes a Doctor stage line before a slow Tracker inspect returns", async () => {
  const repo = await throwawayRepo();
  const inspect = defer();
  const started = defer();
  const out = capturing();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    const running = run({
      config: defineConfig({
        tracker: delayTracker(inner, {
          inspect: { wait: inspect.promise, onStart: started.resolve },
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    await started.promise;
    assert.match(output(out.chunks), /^Doctor$/m);
    inspect.resolve();
    assert.equal(await running, 0);
  } finally {
    inspect.resolve();
    await repo.cleanup();
  }
});

test("a Run writes a Frontier stage line before a slow Frontier fetch returns", async () => {
  const repo = await throwawayRepo();
  const frontier = defer();
  const started = defer();
  const out = capturing();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    const running = run({
      config: defineConfig({
        tracker: delayTracker(inner, {
          frontier: { wait: frontier.promise, onStart: started.resolve },
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    await started.promise;
    assert.match(output(out.chunks), /^Frontier$/m);
    frontier.resolve();
    assert.equal(await running, 0);
  } finally {
    frontier.resolve();
    await repo.cleanup();
  }
});

test("a Run writes a Worktree stage line before it prints the in-flight Ticket", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52", title: "Package the seam" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    const text = output(out.chunks);
    assert.match(text, /^Worktree$/m);
    assert.ok(
      text.indexOf("Worktree\n") < text.indexOf("Ticket 52"),
      "Worktree stage must precede the Ticket line",
    );
  } finally {
    await repo.cleanup();
  }
});

test("the in-flight Ticket line includes id, title, branch, and started/cap", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52", title: "Package the seam" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.match(
      output(out.chunks),
      /^Ticket 52  Package the seam  1\/3  readyrun\/52$/m,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Run writes a Worker stage line before a slow Worker spawn returns", async () => {
  const repo = await throwawayRepo();
  const spawn = defer();
  const started = defer();
  const out = capturing();
  try {
    const running = run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: delaySpawn(
          recordingWorker({ exitCode: 0 }),
          spawn.promise,
          started.resolve,
        ),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    await started.promise;
    assert.match(output(out.chunks), /^Worker$/m);
    spawn.resolve();
    assert.equal(await running, 0);
  } finally {
    spawn.resolve();
    await repo.cleanup();
  }
});

test("Doctor writes a Doctor stage line before a slow Tracker inspect returns", async () => {
  const repo = await throwawayRepo();
  const inspect = defer();
  const started = defer();
  const out = capturing();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    const running = doctor({
      config: defineConfig({
        tracker: delayTracker(inner, {
          inspect: { wait: inspect.promise, onStart: started.resolve },
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    await started.promise;
    assert.match(output(out.chunks), /^Doctor$/m);
    inspect.resolve();
    assert.equal(await running, 0);
  } finally {
    inspect.resolve();
    await repo.cleanup();
  }
});

test("Doctor writes a Frontier stage line before a slow Frontier fetch returns", async () => {
  const repo = await throwawayRepo();
  const frontier = defer();
  const started = defer();
  const out = capturing();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    const running = doctor({
      config: defineConfig({
        tracker: delayTracker(inner, {
          frontier: { wait: frontier.promise, onStart: started.resolve },
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    await started.promise;
    assert.match(output(out.chunks), /^Frontier$/m);
    frontier.resolve();
    assert.equal(await running, 0);
  } finally {
    frontier.resolve();
    await repo.cleanup();
  }
});

const spinnerControl = /[\r\x1b]/;

test("off a TTY, a Run's stage output is newline-delimited and has no spinner control characters", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    const text = output(out.chunks);
    assert.doesNotMatch(text, spinnerControl);
    assert.match(text, /^Doctor\n/m);
    assert.match(text, /^Frontier\n/m);
    assert.match(text, /^Worktree\n/m);
    assert.match(text, /^Worker\n/m);
  } finally {
    await repo.cleanup();
  }
});

test("on a TTY, a Run shows a live Doctor heartbeat before a slow inspect returns", async () => {
  const repo = await throwawayRepo();
  const inspect = defer();
  const started = defer();
  const chunks: string[] = [];
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  try {
    const running = run({
      config: defineConfig({
        tracker: delayTracker(inner, {
          inspect: { wait: inspect.promise, onStart: started.resolve },
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: {
        isTTY: true,
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    await started.promise;
    const text = output(chunks);
    assert.match(text, /Doctor/);
    assert.match(text, spinnerControl);
    inspect.resolve();
    assert.equal(await running, 0);
  } finally {
    inspect.resolve();
    await repo.cleanup();
  }
});
