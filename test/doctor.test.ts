import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cli } from "../src/cli.ts";
import {
  createTrackerAdapter,
  custom,
  defineConfig,
  doctor,
  run,
  UnknownConfigKeyError,
} from "../src/mod.ts";
import type { ReadyRunConfig } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { githubFromWorld } from "./github-http-fixture.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitNpmConsumer, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);
const silent = { write(_chunk?: string) { return true; } };
const unmappedEffort = /Doctor: effort is set but this Worker Adapter does not map it/;

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

function unmappedEffortConfig(effort?: "high") {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: createWorkerAdapter(),
    model: "composer-2",
    ...(effort === undefined ? {} : { effort }),
  });
}

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
    assert.match(chunks.join(""), /Check the Frontier selector/);

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
  const { adapter } = githubFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const config = defineConfig({
    tracker: adapter,
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

test("Doctor and a Run refuse unmapped Effort with the same output", async () => {
  const repo = await throwawayRepo();
  const config = unmappedEffortConfig("high");
  const doctorOut = capturing();
  const runOut = capturing();
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: doctorOut.stdout,
    });
    const runExit = await run({
      config,
      cap: 1,
      cwd: repo.cwd,
      stdout: runOut.stdout,
    });
    assert.equal(doctorExit, 1);
    assert.equal(runExit, 1);
    assert.equal(doctorOut.chunks.join(""), runOut.chunks.join(""));
    assert.match(doctorOut.chunks.join(""), unmappedEffort);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor passes when Effort is set on a Worker Adapter that maps it", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const doctorOut = capturing();
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker,
    model: "opus",
    effort: "high",
  });
  try {
    const doctorExit = await doctor({
      config,
      cwd: repo.cwd,
      stdout: doctorOut.stdout,
    });
    assert.equal(doctorExit, 0);
    assert.doesNotMatch(doctorOut.chunks.join(""), /Doctor: effort/);
    assert.match(doctorOut.chunks.join(""), /Next Ticket: 52/);

    const runExit = await run({
      config,
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(runExit, 0);
    assert.equal(worker.spawns[0]?.effort, "high");
  } finally {
    await repo.cleanup();
  }
});

test("a Run-level Effort override is the same Doctor refusal as config Effort", async () => {
  const repo = await throwawayRepo();
  const configOut = capturing();
  const runOut = capturing();
  try {
    const configExit = await doctor({
      config: unmappedEffortConfig("high"),
      cwd: repo.cwd,
      stdout: configOut.stdout,
    });
    const runExit = await run({
      config: unmappedEffortConfig(),
      cap: 1,
      cwd: repo.cwd,
      stdout: runOut.stdout,
      effort: "max",
    });
    assert.equal(configExit, 1);
    assert.equal(runExit, 1);
    assert.equal(configOut.chunks.join(""), runOut.chunks.join(""));
    assert.match(runOut.chunks.join(""), unmappedEffort);
  } finally {
    await repo.cleanup();
  }
});

test("readyrun doctor and readyrun run refuse unmapped Effort with the same output", async () => {
  const repo = await throwawayRepo();
  const config = unmappedEffortConfig("high");
  const doctorOut = capturing();
  const runOut = capturing();
  try {
    const doctorExit = await cli({
      argv: ["doctor"],
      cwd: repo.cwd,
      stdout: doctorOut.stdout,
      loadConfig: async () => config,
    });
    const runExit = await cli({
      argv: ["run", "--max", "1"],
      cwd: repo.cwd,
      stdout: runOut.stdout,
      loadConfig: async () => config,
    });
    assert.equal(doctorExit, 1);
    assert.equal(runExit, 1);
    assert.equal(doctorOut.chunks.join(""), runOut.chunks.join(""));
    assert.match(doctorOut.chunks.join(""), unmappedEffort);
  } finally {
    await repo.cleanup();
  }
});

test("readyrun run --effort uses the same Doctor refusal as config Effort", async () => {
  const repo = await throwawayRepo();
  const doctorOut = capturing();
  const runOut = capturing();
  try {
    const doctorExit = await cli({
      argv: ["doctor"],
      cwd: repo.cwd,
      stdout: doctorOut.stdout,
      loadConfig: async () => unmappedEffortConfig("high"),
    });
    const runExit = await cli({
      argv: ["run", "--max", "1", "--effort", "max"],
      cwd: repo.cwd,
      stdout: runOut.stdout,
      loadConfig: async () => unmappedEffortConfig(),
    });
    assert.equal(doctorExit, 1);
    assert.equal(runExit, 1);
    assert.equal(doctorOut.chunks.join(""), runOut.chunks.join(""));
    assert.match(runOut.chunks.join(""), unmappedEffort);
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

test("a Worker Adapter probe that reports not ok fails Doctor with a message distinct from a missing binary", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: createWorkerAdapter({
      probe: () => Promise.resolve({ ok: false, detail: "not logged in" }),
    }),
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
      /Doctor: Worker Adapter probe failed: not logged in/,
    );
    assert.doesNotMatch(chunks.join(""), /is missing/);
  } finally {
    await repo.cleanup();
  }
});

test("a Worker Adapter probe that reports ok does not fail Doctor", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  let probed = false;
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: createWorkerAdapter({
      probe: () => {
        probed = true;
        return Promise.resolve({ ok: true });
      },
    }),
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
    assert.ok(probed);
    assert.match(chunks.join(""), /Next Ticket: 52/);
  } finally {
    await repo.cleanup();
  }
});

test("a missing Worker binary skips the probe rather than running it against a binary that isn't there", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  let probed = false;
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: createWorkerAdapter({
      bin: "/no/such/readyrun-worker",
      probe: () => {
        probed = true;
        return Promise.resolve({ ok: true });
      },
    }),
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
    assert.match(chunks.join(""), /Doctor: Worker binary "\/no\/such\/readyrun-worker" is missing/);
    assert.doesNotMatch(chunks.join(""), /probe/);
    assert.equal(probed, false);
  } finally {
    await repo.cleanup();
  }
});

test("a Worker Adapter with no probe defined keeps today's existence-only check", async () => {
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
  });
  assert.equal(worker.probe, undefined);
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
    assert.doesNotMatch(chunks.join(""), /probe/);
  } finally {
    await repo.cleanup();
  }
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
    leaveFrontier: (ticket, landed) => inner.leaveFrontier(ticket, landed),
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

test("a Consumer whose install output is neither tracked nor ignored fails Doctor and a Run will not start", async () => {
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
  });
  try {
    await commitNpmConsumer(repo.cwd);
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
      /Doctor: install output node_modules is neither tracked nor ignored; add it to \.gitignore/,
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

test("a Consumer that ignores its install output does not fail Doctor", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  const config = defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
  try {
    await commitNpmConsumer(repo.cwd);
    await writeFile(join(repo.cwd, ".gitignore"), "node_modules/\n");
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
    assert.doesNotMatch(chunks.join(""), /install output/);
    assert.match(chunks.join(""), /Next Ticket: 52/);
  } finally {
    await repo.cleanup();
  }
});
