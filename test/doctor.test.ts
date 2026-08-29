import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { defineConfig, custom, doctor, github, run, UnknownConfigKeyError } from "../src/mod.ts";
import type { ReadyRunConfig } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createTrackerAdapter } from "../src/tracker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);
const silent = { write(_chunk?: string) { return true; } };

test("a label named in the selector that does not exist on the Tracker fails Doctor and a Run will not start", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["does-not-exist"],
      existingLabels: ["ready-for-agent"],
    }),
    worker,
    model: "composer-2",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: label "does-not-exist" does not exist on the Tracker/,
    );

    const runExit = await run({
      config,
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

test("Doctor reports the Ticket that would be picked next, and that is the Ticket a Run actually starts", async () => {
  const repo = await throwawayRepo();
  const tracker = memoryTracker({
    tickets: [ticket({ id: "57" }), ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  const config = defineConfig({
    tracker,
    worker,
    model: "composer-2",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(doctorExit, 0);
    assert.match(chunks.join(""), /Next Ticket: 52/);

    await run({
      config,
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(worker.spawns[0]?.ticket.id, "52");
  } finally {
    await repo.cleanup();
  }
});

test("a configured repository that is not the git remote fails Doctor and a Run will not start", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  await exec("git", [
    "-C",
    repo.cwd,
    "remote",
    "add",
    "origin",
    "git@github.com:other/place.git",
  ]);
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: github({
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
    model: "composer-2",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: configured repository acme\/widgets is not the git remote \(other\/place\)/,
    );

    const runExit = await run({
      config,
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

test("claiming unblocked when the Tracker cannot express blocking fails Doctor and a Run will not start", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      canExpressBlocking: false,
    }),
    worker,
    model: "composer-2",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: Tracker cannot express blocking; unblocked ordering is a lie/,
    );

    const runExit = await run({
      config,
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

test("a missing Worker binary fails Doctor and a Run will not start", async () => {
  const repo = await throwawayRepo();
  const worker = custom({
    bin: "/no/such/readyrun-worker",
    unattendedFlag: "--dangerously-skip-permissions",
  });
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
    model: "composer-2",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: Worker binary "\/no\/such\/readyrun-worker" is missing/,
    );

    const runChunks: string[] = [];
    const runExit = await run({
      config,
      cap: 1,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          runChunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(runExit, 1);
    assert.match(
      runChunks.join(""),
      /Doctor: Worker binary "\/no\/such\/readyrun-worker" is missing/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a missing model default fails Doctor and a Run will not start", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  const config = {
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
  } as unknown as ReadyRunConfig;
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 1);
    assert.match(chunks.join(""), /Doctor: missing model default/);

    const runExit = await run({
      config,
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

test("a by-label model map that matches no Tickets is a warning, not a failure", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
    model: "composer-2",
    modelsByLabel: { review: "haiku" },
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 0);
    assert.match(
      chunks.join(""),
      /Warning: modelsByLabel key "review" matches no Tickets on the Frontier/,
    );
    assert.match(chunks.join(""), /Next Ticket: 52/);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor reports an empty Frontier without failing", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  try {
    const doctorExit = await doctor({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "99", labels: ["other"] })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(doctorExit, 0);
    assert.match(chunks.join(""), /Frontier is empty/);
  } finally {
    await repo.cleanup();
  }
});

test("unknown keys fail Doctor", async () => {
  const config = {
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
    unknownKnob: true,
  };

  await assert.rejects(
    () => doctor({ config }),
    (error: unknown) => {
      assert.ok(error instanceof UnknownConfigKeyError);
      assert.deepEqual([...error.keys], ["unknownKnob"]);
      return true;
    },
  );
});

test("the check runs once at Run start, not on every iteration", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  let inspects = 0;
  const tracker = createTrackerAdapter({
    frontier: () => inner.frontier(),
    branchName: (ticket) => inner.branchName(ticket),
    leaveFrontier: (ticket) => inner.leaveFrontier(ticket),
    promptCopy: (ticket) => inner.promptCopy(ticket),
    inspect() {
      inspects += 1;
      if (inspects > 1) {
        return Promise.reject(new Error("Doctor check ran more than once"));
      }
      return inner.inspect();
    },
  });
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker,
        worker,
        model: "composer-2",
      }),
      cap: 2,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(
      worker.spawns.map((spawn) => spawn.ticket.id),
      ["52", "57"],
    );
  } finally {
    await repo.cleanup();
  }
});
