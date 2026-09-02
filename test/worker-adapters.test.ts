import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { claude, cursor, custom, defineConfig, doctor, run } from "../src/mod.ts";
import { memoryTracker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };
const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

type SpawnReceipt = {
  bin: string;
  argv: string[];
  cwd: string;
};

const stubSource = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
writeFileSync(process.env.READYRUN_SPAWN_RECEIPT, JSON.stringify({
  bin: basename(process.argv[1]),
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}));
if (process.env.READYRUN_STUB_STDOUT !== undefined) {
  process.stdout.write(process.env.READYRUN_STUB_STDOUT);
}
process.exitCode = Number(process.env.READYRUN_STUB_EXIT_CODE ?? "0");
`;

async function withRecordingPath(
  names: string[],
  fn: (paths: { bin: string; receiptPath: string }) => Promise<void>,
): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(join(tmpRoot, "bin-"));
  const receiptPath = join(dir, "receipt.json");
  for (const name of names) {
    await writeFile(join(dir, name), stubSource, { mode: 0o755 });
  }
  const previousPath = process.env.PATH;
  const previousReceipt = process.env.READYRUN_SPAWN_RECEIPT;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  process.env.READYRUN_SPAWN_RECEIPT = receiptPath;
  try {
    await fn({ bin: join(dir, names[0] ?? "stub"), receiptPath });
  } finally {
    process.env.PATH = previousPath;
    if (previousReceipt === undefined) {
      delete process.env.READYRUN_SPAWN_RECEIPT;
    } else {
      process.env.READYRUN_SPAWN_RECEIPT = previousReceipt;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function readReceipt(receiptPath: string): Promise<SpawnReceipt> {
  return JSON.parse(await readFile(receiptPath, "utf8")) as SpawnReceipt;
}

describe("Worker Adapters", { concurrency: false }, () => {
  test("a custom Worker Adapter Run spawns that binary with the prompt, model, and Worktree as cwd", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin,
              unattendedFlag: "--go",
            }),
            model: "composer-2",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.equal(receipt.bin, "readyrun-worker");
        assert.equal(receipt.argv[0], "--model");
        assert.equal(receipt.argv[1], "composer-2");
        assert.match(receipt.argv.at(-1) ?? "", /52/);
        assert.match(receipt.argv.at(-1) ?? "", /Ticket 52/);
        assert.notEqual(receipt.cwd, repo.cwd);
        assert.match(receipt.cwd, /worktrees/);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("unattended maps to the custom Worker Adapter's flag; ask does not pass it", async () => {
    await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
      const unattendedRepo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin,
              unattendedFlag: "--go",
            }),
            model: "composer-2",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: unattendedRepo.cwd,
          stdout: silent,
        });

        const unattended = await readReceipt(receiptPath);
        assert.ok(unattended.argv.includes("--go"));
      } finally {
        await unattendedRepo.cleanup();
      }

      const askRepo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin,
              unattendedFlag: "--go",
            }),
            model: "composer-2",
          }),
          cap: 1,
          cwd: askRepo.cwd,
          stdout: silent,
        });

        const ask = await readReceipt(receiptPath);
        assert.ok(!ask.argv.includes("--go"));
      } finally {
        await askRepo.cleanup();
      }
    });
  });

  test("a custom Worker Adapter includes the Consumer's extra args before model and prompt", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin,
              args: ["--print", "--extra"],
              unattendedFlag: "--go",
            }),
            model: "composer-2",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 4), [
          "--print",
          "--extra",
          "--model",
          "composer-2",
        ]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("a Cursor Worker Adapter Run spawns the Worker with the prompt, model, Worktree cwd, and Cursor's unattended flag", async () => {
    await withRecordingPath(["agent"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor(),
            model: "composer-2",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const unattended = await readReceipt(receiptPath);
        assert.equal(unattended.bin, "agent");
        assert.equal(unattended.argv[0], "-p");
        assert.equal(unattended.argv[1], "--model");
        assert.equal(unattended.argv[2], "composer-2");
        assert.ok(unattended.argv.includes("--yolo"));
        assert.match(unattended.argv.at(-1) ?? "", /52/);
        assert.notEqual(unattended.cwd, repo.cwd);
        assert.match(unattended.cwd, /worktrees/);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a Claude Worker Adapter Run spawns the Worker with the prompt, model, Worktree cwd, and Claude's unattended flag", async () => {
    await withRecordingPath(["claude"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const unattended = await readReceipt(receiptPath);
        assert.equal(unattended.bin, "claude");
        assert.equal(unattended.argv[0], "-p");
        assert.equal(unattended.argv[1], "--model");
        assert.equal(unattended.argv[2], "opus");
        assert.ok(unattended.argv.includes("--dangerously-skip-permissions"));
        assert.match(unattended.argv.at(-1) ?? "", /52/);
        assert.notEqual(unattended.cwd, repo.cwd);
        assert.match(unattended.cwd, /worktrees/);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a Claude Worker Adapter maps Effort to --effort; omitting Effort does not pass the flag", async () => {
    await withRecordingPath(["claude"], async ({ receiptPath }) => {
      const withEffort = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
            effort: "high",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: withEffort.cwd,
          stdout: silent,
        });
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 5), [
          "-p",
          "--model",
          "opus",
          "--effort",
          "high",
        ]);
      } finally {
        await withEffort.cleanup();
      }

      const withoutEffort = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: withoutEffort.cwd,
          stdout: silent,
        });
        const receipt = await readReceipt(receiptPath);
        assert.ok(!receipt.argv.includes("--effort"));
      } finally {
        await withoutEffort.cleanup();
      }
    });
  });

  test("Effort on a Cursor Worker Adapter fails Doctor and a Run will not start", async () => {
    await withRecordingPath(["agent"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      const doctorChunks: string[] = [];
      const runChunks: string[] = [];
      const config = defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: cursor(),
        model: "composer-2.5-fast",
        effort: "high",
        permissions: "unattended",
      });
      try {
        const doctorExit = await doctor({
          config,
          cwd: repo.cwd,
          stdout: {
            write(chunk: string) {
              doctorChunks.push(chunk);
              return true;
            },
          },
        });
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
        assert.equal(doctorExit, 1);
        assert.equal(runExit, 1);
        assert.equal(doctorChunks.join(""), runChunks.join(""));
        assert.match(
          doctorChunks.join(""),
          /Doctor: effort is set but this Worker Adapter does not map it/,
        );
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["status"]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("print-mode spawn with ask permissions fails Doctor and a Run will not start", async () => {
    const askPrintMode = /Doctor: .*--permissions unattended/;
    for (const { bin, worker, model, probeArgv } of [
      { bin: "agent", worker: cursor(), model: "composer-2", probeArgv: ["status"] },
      { bin: "claude", worker: claude(), model: "opus", probeArgv: ["auth", "status"] },
    ]) {
      await withRecordingPath([bin], async ({ receiptPath }) => {
        const repo = await throwawayRepo();
        const doctorChunks: string[] = [];
        const runChunks: string[] = [];
        const config = defineConfig({
          tracker: memoryTracker({
            tickets: [ticket({ id: "52" })],
            ready: "unblocked",
            labels: ["ready-for-agent"],
          }),
          worker,
          model,
        });
        const stdout = (chunks: string[]) => ({
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        });
        try {
          const doctorExit = await doctor({
            config,
            cwd: repo.cwd,
            stdout: stdout(doctorChunks),
          });
          const runExit = await run({
            config,
            cap: 1,
            cwd: repo.cwd,
            stdout: stdout(runChunks),
          });
          assert.equal(doctorExit, 1);
          assert.equal(runExit, 1);
          assert.equal(doctorChunks.join(""), runChunks.join(""));
          assert.match(doctorChunks.join(""), askPrintMode);
          const receipt = await readReceipt(receiptPath);
          assert.deepEqual(receipt.argv, probeArgv);
        } finally {
          await repo.cleanup();
        }
      });
    }
  });

  test("a Run-level unattended override lets print-mode spawn with the Worker Adapter's unattended flag", async () => {
    await withRecordingPath(["claude"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
          permissions: "unattended",
        });
        const receipt = await readReceipt(receiptPath);
        assert.equal(receipt.argv[0], "-p");
        assert.ok(receipt.argv.includes("--dangerously-skip-permissions"));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a custom Worker Adapter maps Effort to --effort", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin,
              unattendedFlag: "--go",
            }),
            model: "local-model",
            effort: "medium",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 4), [
          "--model",
          "local-model",
          "--effort",
          "medium",
        ]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("Doctor fails when the Cursor Worker binary is missing, and a Run will not start", async () => {
    const repo = await throwawayRepo();
    const previousPath = process.env.PATH;
    process.env.PATH = "/no/such/readyrun-path";
    const chunks: string[] = [];
    const config = defineConfig({
      tracker: memoryTracker({
        tickets: [ticket({ id: "52" })],
        ready: "unblocked",
        labels: ["ready-for-agent"],
      }),
      worker: cursor(),
      model: "composer-2",
    });
    const stdout = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };
    try {
      const doctorExit = await doctor({ config, cwd: repo.cwd, stdout });
      assert.equal(doctorExit, 1);
      assert.match(chunks.join(""), /Doctor: Worker binary "agent" is missing/);

      chunks.length = 0;
      const runExit = await run({
        config,
        cap: 1,
        cwd: repo.cwd,
        stdout,
      });
      assert.equal(runExit, 1);
      assert.match(chunks.join(""), /Doctor: Worker binary "agent" is missing/);
    } finally {
      process.env.PATH = previousPath;
      await repo.cleanup();
    }
  });

  test("Doctor fails when the Claude Worker binary is missing", async () => {
    const repo = await throwawayRepo();
    const previousPath = process.env.PATH;
    process.env.PATH = "/no/such/readyrun-path";
    const chunks: string[] = [];
    try {
      const doctorExit = await doctor({
        config: defineConfig({
          tracker: memoryTracker({
            tickets: [ticket({ id: "52" })],
            ready: "unblocked",
            labels: ["ready-for-agent"],
          }),
          worker: claude(),
          model: "opus",
        }),
        cwd: repo.cwd,
        stdout: {
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        },
      });
      assert.equal(doctorExit, 1);
      assert.match(chunks.join(""), /Doctor: Worker binary "claude" is missing/);
    } finally {
      process.env.PATH = previousPath;
      await repo.cleanup();
    }
  });

  test("a Cursor Worker Adapter includes the Consumer's extra args between -p and --model", async () => {
    await withRecordingPath(["agent"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor({ extraArgs: ["--reasoning-effort", "high"] }),
            model: "composer-2",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 5), [
          "-p",
          "--reasoning-effort",
          "high",
          "--model",
          "composer-2",
        ]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a Claude Worker Adapter includes the Consumer's extra args between -p and --model", async () => {
    await withRecordingPath(["claude"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude({ extraArgs: ["--verbose"] }),
            model: "opus",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 4), [
          "-p",
          "--verbose",
          "--model",
          "opus",
        ]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("Doctor runs the Cursor Worker Adapter's probe and passes when it reports authenticated", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["agent"], async ({ receiptPath }) => {
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor(),
            model: "composer-2",
            permissions: "unattended",
          }),
          cwd: repo.cwd,
          stdout: silent,
        });
        assert.equal(doctorExit, 0);
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["status"]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("Doctor fails with a probe-specific message when the Cursor CLI reports not authenticated", async () => {
    const repo = await throwawayRepo();
    const previousExitCode = process.env.READYRUN_STUB_EXIT_CODE;
    process.env.READYRUN_STUB_EXIT_CODE = "1";
    try {
      await withRecordingPath(["agent"], async () => {
        const chunks: string[] = [];
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor(),
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
        assert.equal(doctorExit, 1);
        assert.match(chunks.join(""), /Doctor: Worker Adapter probe failed/);
        assert.doesNotMatch(chunks.join(""), /is missing/);
      });
    } finally {
      if (previousExitCode === undefined) {
        delete process.env.READYRUN_STUB_EXIT_CODE;
      } else {
        process.env.READYRUN_STUB_EXIT_CODE = previousExitCode;
      }
      await repo.cleanup();
    }
  });

  test("Doctor fails the Cursor probe on auth-failure text even when the CLI exits 0", async () => {
    const repo = await throwawayRepo();
    const previousStdout = process.env.READYRUN_STUB_STDOUT;
    process.env.READYRUN_STUB_STDOUT = "Not authenticated. Run agent login.";
    try {
      await withRecordingPath(["agent"], async () => {
        const chunks: string[] = [];
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor(),
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
        assert.equal(doctorExit, 1);
        assert.match(chunks.join(""), /Doctor: Worker Adapter probe failed/);
      });
    } finally {
      if (previousStdout === undefined) {
        delete process.env.READYRUN_STUB_STDOUT;
      } else {
        process.env.READYRUN_STUB_STDOUT = previousStdout;
      }
      await repo.cleanup();
    }
  });

  test("Doctor runs the Claude Worker Adapter's probe and passes when it reports authenticated", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["claude"], async ({ receiptPath }) => {
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
            permissions: "unattended",
          }),
          cwd: repo.cwd,
          stdout: silent,
        });
        assert.equal(doctorExit, 0);
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["auth", "status"]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("Doctor fails with a probe-specific message when the Claude CLI reports not authenticated", async () => {
    const repo = await throwawayRepo();
    const previousExitCode = process.env.READYRUN_STUB_EXIT_CODE;
    process.env.READYRUN_STUB_EXIT_CODE = "1";
    try {
      await withRecordingPath(["claude"], async () => {
        const chunks: string[] = [];
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude(),
            model: "opus",
          }),
          cwd: repo.cwd,
          stdout: {
            write(chunk: string) {
              chunks.push(chunk);
              return true;
            },
          },
        });
        assert.equal(doctorExit, 1);
        assert.match(chunks.join(""), /Doctor: Worker Adapter probe failed/);
        assert.doesNotMatch(chunks.join(""), /is missing/);
      });
    } finally {
      if (previousExitCode === undefined) {
        delete process.env.READYRUN_STUB_EXIT_CODE;
      } else {
        process.env.READYRUN_STUB_EXIT_CODE = previousExitCode;
      }
      await repo.cleanup();
    }
  });

  test("a Run also refuses to start when the Cursor CLI probe reports not authenticated", async () => {
    const repo = await throwawayRepo();
    const previousExitCode = process.env.READYRUN_STUB_EXIT_CODE;
    process.env.READYRUN_STUB_EXIT_CODE = "1";
    try {
      await withRecordingPath(["agent"], async ({ receiptPath }) => {
        const chunks: string[] = [];
        const runExit = await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: cursor(),
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
        assert.equal(runExit, 1);
        assert.match(chunks.join(""), /Doctor: Worker Adapter probe failed/);
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["status"]);
      });
    } finally {
      if (previousExitCode === undefined) {
        delete process.env.READYRUN_STUB_EXIT_CODE;
      } else {
        process.env.READYRUN_STUB_EXIT_CODE = previousExitCode;
      }
      await repo.cleanup();
    }
  });

  test("Doctor does not spawn a custom Worker Adapter with no probe defined", async () => {
    const repo = await throwawayRepo();
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({ bin, unattendedFlag: "--go" }),
            model: "composer-2",
          }),
          cwd: repo.cwd,
          stdout: silent,
        });
        assert.equal(doctorExit, 0);
        assert.equal(existsSync(receiptPath), false);
      });
    } finally {
      await repo.cleanup();
    }
  });
});
