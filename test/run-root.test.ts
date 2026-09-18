import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTrackerAdapter,
  defineConfig,
  doctor,
  run,
} from "../src/mod.ts";
import type { FrontierRoot, Ticket } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

function capturing() {
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

function rootConfig(tickets: Ticket[], worker = recordingWorker({ exitCode: 0 })) {
  return defineConfig({
    tracker: memoryTracker({
      tickets,
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
    model: "composer-2",
  });
}

test("an explicit list runs exactly the named Tickets, bypassing the selector", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: rootConfig([
        ticket({ id: "52" }),
        ticket({ id: "99", labels: ["other"] }),
        ticket({ id: "57" }),
      ], worker),
      root: { kind: "list", ids: ["99", "57"] },
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["57", "99"]);
  } finally {
    await repo.cleanup();
  }
});

test("an explicit list defaults the cap to the list's length", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const exit = await run({
      config: rootConfig([
        ticket({ id: "52" }),
        ticket({ id: "53" }),
        ticket({ id: "57" }),
      ], worker),
      root: { kind: "list", ids: ["52", "57"] },
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(exit, 0);
    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "57"]);
  } finally {
    await repo.cleanup();
  }
});

test("a list longer than the cap keeps its remainder on the Frontier", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  try {
    await run({
      config: rootConfig([
        ticket({ id: "52" }),
        ticket({ id: "53" }),
        ticket({ id: "57" }),
      ], worker),
      root: { kind: "list", ids: ["52", "53", "57"] },
      cap: 2,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "53"]);
    assert.match(out.chunks.join(""), /cap of 2/);
    assert.match(
      out.chunks.join(""),
      /Continue with: readyrun run --max 2 --base readyrun\/run-\d+-\d+ --ticket 52 53 57/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a named blocked Ticket waits off the Frontier and joins mid-Run", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: rootConfig([
        ticket({ id: "52" }),
        ticket({ id: "53", blockedBy: ["52"] }),
      ], worker),
      root: { kind: "list", ids: ["52", "53"] },
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["52", "53"]);
  } finally {
    await repo.cleanup();
  }
});

test("a named blocked Ticket is warned as waiting work, not refused", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  try {
    await run({
      config: rootConfig([
        ticket({ id: "53", blockedBy: ["52"] }),
      ], worker),
      root: { kind: "list", ids: ["53"] },
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    const output = out.chunks.join("");
    assert.match(output, /Warning: Ticket 53 is waiting work/);
    assert.match(output, /the Frontier is empty/);
    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a parent root runs only that parent's children and never the parent itself", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    await run({
      config: rootConfig([
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "8" }),
      ], worker),
      root: { kind: "parent", id: "8" },
      cap: 3,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["11"]);
  } finally {
    await repo.cleanup();
  }
});

test("a parent whose children are all blocked warns and stops clean", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  try {
    await run({
      config: rootConfig([
        ticket({ id: "8" }),
        ticket({ id: "11", parent: "8", blockedBy: ["8"] }),
      ], worker),
      root: { kind: "parent", id: "8" },
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    const output = out.chunks.join("");
    assert.match(output, /Warning: no unblocked children under --root 8/);
    assert.match(output, /the Frontier is empty/);
    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a command-line root replaces the config-level root for that Run", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const config = defineConfig({
      tracker: memoryTracker({
        tickets: [
          ticket({ id: "11", parent: "8" }),
          ticket({ id: "12", parent: "9" }),
          ticket({ id: "8" }),
          ticket({ id: "9" }),
        ],
        ready: "unblocked",
        labels: ["ready-for-agent"],
        parent: "8",
      }),
      worker,
      model: "composer-2",
    });
    await run({
      config,
      root: { kind: "parent", id: "9" },
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.deepEqual(worker.spawns.map((spawn) => spawn.ticket.id), ["12"]);
  } finally {
    await repo.cleanup();
  }
});

test("a named Ticket that can never join the Frontier refuses Doctor and the Run", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  const config = rootConfig([ticket({ id: "52" })], worker);
  try {
    const doctorExit = await doctor({
      config,
      root: { kind: "list", ids: ["52", "999"] },
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(doctorExit, 1);
    assert.match(out.chunks.join(""), /Doctor: Ticket 999 does not exist/);

    const runExit = await run({
      config,
      root: { kind: "list", ids: ["52", "999"] },
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(runExit, 1);
    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("an Adapter that answers outside the named root is caught and refused", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  try {
    const config = defineConfig({
      tracker: createTrackerAdapter({
        frontier: () =>
          Promise.resolve([
            ticket({ id: "52" }),
            ticket({ id: "99", labels: ["other"] }),
          ]),
        inspect: () =>
          Promise.resolve({
            existingLabels: ["ready-for-agent"],
            selectorLabels: ["ready-for-agent"],
            canExpressBlocking: true,
          }),
      }),
      worker,
      model: "composer-2",
    });
    const doctorExit = await doctor({
      config,
      root: { kind: "list", ids: ["52"] },
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(doctorExit, 1);
    assert.match(
      out.chunks.join(""),
      /Doctor: Ticket 99 is not in the named root/,
    );

    const runExit = await run({
      config,
      root: { kind: "list", ids: ["52"] },
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(runExit, 1);
    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a root for a Tracker Adapter that cannot read parents is refused", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const out = capturing();
  try {
    const config = defineConfig({
      tracker: createTrackerAdapter(),
      worker,
      model: "composer-2",
    });
    const doctorExit = await doctor({
      config,
      root: { kind: "parent", id: "8" },
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(doctorExit, 1);
    assert.match(out.chunks.join(""), /Doctor: .*does not honor a root/);

    const runExit = await run({
      config,
      root: { kind: "parent", id: "8" },
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(runExit, 1);
    assert.equal(worker.spawns.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor pre-flights the rooted lie-check and names the next rooted Ticket", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exit = await doctor({
      config: rootConfig([
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "8" }),
      ]),
      root: { kind: "parent", id: "8" },
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(exit, 0);
    assert.match(out.chunks.join(""), /Next Ticket: 11/);
  } finally {
    await repo.cleanup();
  }
});
