import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, test } from "node:test";
import { spawnWorkerBinary } from "../src/worker-adapter.ts";
import { claude, cursor, custom, defineConfig, doctor, opencode, run } from "../src/mod.ts";
import type { ReadyRunConfig, WorkerAdapter } from "../src/mod.ts";
import { memoryTracker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";
import { readReceipt, withRecordingPath } from "./stub-worker.ts";

const silent = { write(_chunk?: string) { return true; } };


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

  test("a custom Worker Adapter's {cwd} arg is interpolated with the Worktree path", async () => {    const repo = await throwawayRepo();
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
              args: ["run", "--dir", "{cwd}"],
              unattendedFlag: "--go",
            }),
            model: "composer-2",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.equal(receipt.argv[0], "run");
        assert.equal(receipt.argv[1], "--dir");
        assert.notEqual(receipt.argv[2], "{cwd}");
        assert.ok(isAbsolute(receipt.argv[2] ?? ""));
        assert.match(receipt.argv[2] ?? "", /worktrees/);
        assert.deepEqual(receipt.argv.slice(3, 5), ["--model", "composer-2"]);
        assert.notEqual(receipt.cwd, repo.cwd);
        assert.equal(receipt.cwd, receipt.argv[2]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("a print-mode Worker Adapter's {cwd} extraArg is interpolated with the Worktree path", async () => {
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
            worker: claude({ extraArgs: ["--dir", "{cwd}"] }),
            model: "opus",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 5), [
          "-p",
          "--dir",
          receipt.cwd,
          "--model",
          "opus",
        ]);
        assert.notEqual(receipt.argv[2], "{cwd}");
        assert.ok(isAbsolute(receipt.argv[2] ?? ""));
        assert.match(receipt.argv[2] ?? "", /worktrees/);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a custom Worker Adapter's {cwd} interpolates in the first position and inside a larger token", async () => {
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
              args: ["{cwd}", "--dir={cwd}"],
              unattendedFlag: "--go",
            }),
            model: "composer-2",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.equal(receipt.argv[0], receipt.cwd);
        assert.equal(receipt.argv[1], `--dir=${receipt.cwd}`);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("an unknown {token} embedded in a larger argv token fails Doctor", async () => {
    const repo = await throwawayRepo();
    const chunks: string[] = [];
    try {
      await withRecordingPath(["readyrun-worker"], async () => {
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: custom({
              bin: "readyrun-worker",
              args: ["--dir={dir}"],
              unattendedFlag: "--go",
            }),
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
        assert.match(
          chunks.join(""),
          /Doctor: Worker Adapter option "args" has unknown placeholder "\{dir\}"\. Only \{cwd\} is available\./,
        );
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("an unknown {token} placeholder in a custom Worker Adapter's args fails Doctor and a Run does not start", async () => {
    const repo = await throwawayRepo();
    const chunks: string[] = [];
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin, receiptPath }) => {
        const config = defineConfig({
          tracker: memoryTracker({
            tickets: [ticket({ id: "52" })],
            ready: "unblocked",
            labels: ["ready-for-agent"],
          }),
          worker: custom({
            bin,
            args: ["run", "--dir", "{dir}"],
            unattendedFlag: "--go",
          }),
          model: "composer-2",
        });
        const stdout = {
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        };
        const doctorExit = await doctor({ config, cwd: repo.cwd, stdout });
        assert.equal(doctorExit, 1);
        assert.match(
          chunks.join(""),
          /Doctor: Worker Adapter option "args" has unknown placeholder "\{dir\}"\. Only \{cwd\} is available\./,
        );
        chunks.length = 0;
        const runExit = await run({ config, cap: 1, cwd: repo.cwd, stdout });
        assert.equal(runExit, 1);
        assert.match(chunks.join(""), /unknown placeholder "\{dir\}"/);
        assert.equal(existsSync(receiptPath), false);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("an unknown {token} placeholder in a print-mode Worker Adapter's extraArgs fails Doctor", async () => {
    const repo = await throwawayRepo();
    const chunks: string[] = [];
    try {
      await withRecordingPath(["claude"], async ({ receiptPath }) => {
        const doctorExit = await doctor({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: claude({ extraArgs: ["--dir", "{cw}"] }),
            model: "opus",
            permissions: "unattended",
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
        assert.match(
          chunks.join(""),
          /Doctor: Worker Adapter option "extraArgs" has unknown placeholder "\{cw\}"\. Only \{cwd\} is available\./,
        );
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["auth", "status"]);
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

  test("an opencode Worker Adapter Run renders the exact argv the shrunken wro config shape needs", async () => {
    await withRecordingPath(["opencode"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: opencode(),
            model: "zai-coding-plan/glm-5.3-flash",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.equal(receipt.bin, "opencode");
        assert.deepEqual(receipt.argv.slice(0, 6), [
          "run",
          "--dir",
          receipt.cwd,
          "--model",
          "zai-coding-plan/glm-5.3-flash",
          "--auto",
        ]);
        assert.equal(receipt.argv.length, 7);
        assert.match(receipt.argv.at(-1) ?? "", /52/);
        assert.ok(!receipt.argv.includes("-p"));
        assert.ok(!receipt.argv.includes("-i"));
        assert.notEqual(receipt.cwd, repo.cwd);
        assert.match(receipt.cwd, /worktrees/);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("an opencode Worker Adapter includes the Consumer's extra args between --dir and --model", async () => {
    await withRecordingPath(["opencode"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      try {
        await run({
          config: defineConfig({
            tracker: memoryTracker({
              tickets: [ticket({ id: "52" })],
              ready: "unblocked",
              labels: ["ready-for-agent"],
            }),
            worker: opencode({ extraArgs: ["--title", "Ticket 52"] }),
            model: "zai-coding-plan/glm-5.3-flash",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });

        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv.slice(0, 8), [
          "run",
          "--dir",
          receipt.cwd,
          "--title",
          "Ticket 52",
          "--model",
          "zai-coding-plan/glm-5.3-flash",
          "--auto",
        ]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("an opencode Worker Adapter maps Effort to --variant for the values it declares; omitting Effort passes no flag", async () => {
    await withRecordingPath(["opencode"], async ({ receiptPath }) => {
      for (const effort of ["high", "max"] as const) {
        const withEffort = await throwawayRepo();
        try {
          await run({
            config: defineConfig({
              tracker: memoryTracker({
                tickets: [ticket({ id: "52" })],
                ready: "unblocked",
                labels: ["ready-for-agent"],
              }),
              worker: opencode(),
              model: "zai-coding-plan/glm-5.3-flash",
              effort,
              permissions: "unattended",
            }),
            cap: 1,
            cwd: withEffort.cwd,
            stdout: silent,
          });
          const receipt = await readReceipt(receiptPath);
          assert.deepEqual(receipt.argv.slice(5, 8), [
            "--variant",
            effort,
            "--auto",
          ]);
          assert.equal(receipt.argv.length, 9);
        } finally {
          await withEffort.cleanup();
        }
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
            worker: opencode(),
            model: "zai-coding-plan/glm-5.3-flash",
            permissions: "unattended",
          }),
          cap: 1,
          cwd: withoutEffort.cwd,
          stdout: silent,
        });
        const receipt = await readReceipt(receiptPath);
        assert.ok(!receipt.argv.includes("--variant"));
      } finally {
        await withoutEffort.cleanup();
      }
    });
  });

  test("Effort outside opencode's declared vocabulary fails Doctor and a Run will not start", async () => {
    await withRecordingPath(["opencode"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      const chunks: string[] = [];
      // opencode declares high | max, so a typed config cannot carry "low";
      // the wide annotation is the runtime lie a JS config file (which
      // TypeScript never checks) can still hand Doctor.
      const raw: ReadyRunConfig = {
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: opencode(),
        model: "zai-coding-plan/glm-5.3-flash",
        effort: "low",
        permissions: "unattended",
      };
      const config = defineConfig(raw);
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
        const runExit = await run({
          config,
          cap: 1,
          cwd: repo.cwd,
          stdout: {
            write(chunk: string) {
              chunks.push(chunk);
              return true;
            },
          },
        });
        assert.equal(doctorExit, 1);
        assert.equal(runExit, 1);
        assert.match(
          chunks.join(""),
          /Doctor: effort "low" is not in the Effort vocabulary .* declares \(high, max\)/,
        );
        const receipt = await readReceipt(receiptPath);
        assert.deepEqual(receipt.argv, ["auth", "list"]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("Doctor runs the opencode Worker Adapter's auth probe and passes when it reports credentials", async () => {
    const previousStdout = process.env.READYRUN_STUB_STDOUT;
    process.env.READYRUN_STUB_STDOUT = "└  1 credentials\n";
    try {
      await withRecordingPath(["opencode"], async ({ receiptPath }) => {
        const repo = await throwawayRepo();
        try {
          const doctorExit = await doctor({
            config: defineConfig({
              tracker: memoryTracker({
                tickets: [ticket({ id: "52" })],
                ready: "unblocked",
                labels: ["ready-for-agent"],
              }),
              worker: opencode(),
              model: "zai-coding-plan/glm-5.3-flash",
              permissions: "unattended",
            }),
            cwd: repo.cwd,
            stdout: silent,
          });
          assert.equal(doctorExit, 0);
          const receipt = await readReceipt(receiptPath);
          assert.deepEqual(receipt.argv, ["auth", "list"]);
        } finally {
          await repo.cleanup();
        }
      });
    } finally {
      if (previousStdout === undefined) {
        delete process.env.READYRUN_STUB_STDOUT;
      } else {
        process.env.READYRUN_STUB_STDOUT = previousStdout;
      }
    }
  });

  test("Doctor fails with the probe's detail when the opencode CLI shows zero credentials", async () => {
    const previousStdout = process.env.READYRUN_STUB_STDOUT;
    process.env.READYRUN_STUB_STDOUT = "└  0 credentials\n";
    try {
      await withRecordingPath(["opencode"], async ({ receiptPath }) => {
        const repo = await throwawayRepo();
        const chunks: string[] = [];
        try {
          const doctorExit = await doctor({
            config: defineConfig({
              tracker: memoryTracker({
                tickets: [ticket({ id: "52" })],
                ready: "unblocked",
                labels: ["ready-for-agent"],
              }),
              worker: opencode(),
              model: "zai-coding-plan/glm-5.3-flash",
              permissions: "unattended",
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
          assert.match(chunks.join(""), /0 credentials/);
          assert.doesNotMatch(chunks.join(""), /is missing/);
          const receipt = await readReceipt(receiptPath);
          assert.deepEqual(receipt.argv, ["auth", "list"]);
        } finally {
          await repo.cleanup();
        }
      });
    } finally {
      if (previousStdout === undefined) {
        delete process.env.READYRUN_STUB_STDOUT;
      } else {
        process.env.READYRUN_STUB_STDOUT = previousStdout;
      }
    }
  });

  test("the opencode Worker Adapter's probe reports not installed on a spawn error", async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "/no/such/readyrun-path";
    try {
      const probe = opencode().probe;
      assert.ok(probe !== undefined);
      const result = await probe();
      assert.ok(!result.ok);
      assert.match(result.detail, /ENOENT/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("Effort on a Cursor Worker Adapter fails Doctor and a Run will not start", async () => {
    await withRecordingPath(["agent"], async ({ receiptPath }) => {
      const repo = await throwawayRepo();
      const doctorChunks: string[] = [];
      const runChunks: string[] = [];
      // Cursor declares no Effort vocabulary, so a typed config cannot carry
      // one; the wide annotation is the runtime lie a JS config file (which
      // TypeScript never checks) can still hand Doctor.
      const raw: ReadyRunConfig = {
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: cursor(),
        model: "composer-2.5-fast",
        effort: "high",
        permissions: "unattended",
      };
      const config = defineConfig(raw);
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
    const printModeAdapters: Array<{
      bin: string;
      worker: WorkerAdapter;
      model: string;
      probeArgv: string[];
    }> = [
      { bin: "agent", worker: cursor(), model: "composer-2", probeArgv: ["status"] },
      { bin: "claude", worker: claude(), model: "opus", probeArgv: ["auth", "status"] },
      {
        bin: "opencode",
        worker: opencode(),
        model: "zai-coding-plan/glm-5.3-flash",
        probeArgv: ["auth", "list"],
      },
    ];
    for (const { bin, worker, model, probeArgv } of printModeAdapters) {
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

  test("a custom Worker Adapter maps Effort to the flag it declares, only for declared values", async () => {
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
              effortFlag: "--thinking",
              effortVocabulary: ["medium"],
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
          "--thinking",
          "medium",
        ]);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("a custom Worker Adapter that maps no Effort passes no effort flag", async () => {
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
            permissions: "unattended",
          }),
          cap: 1,
          cwd: repo.cwd,
          stdout: silent,
        });
        const receipt = await readReceipt(receiptPath);
        assert.ok(!receipt.argv.includes("--effort"));
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

  test("a custom Worker Adapter with no auth probe is still spawned once by Doctor's cwd-fidelity probe, inside the probe Worktree", async () => {
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
        const receipt = await readReceipt(receiptPath);
        assert.match(
          receipt.argv.at(-1) ?? "",
          /git rev-parse --show-toplevel/,
        );
        assert.notEqual(receipt.cwd, repo.cwd);
        assert.match(receipt.cwd, /readyrun-cwd-probe-/);
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("spawnWorkerBinary with capture pipes the Worker's stdout back instead of inheriting it", async () => {
    const previousStdout = process.env.READYRUN_STUB_STDOUT;
    process.env.READYRUN_STUB_STDOUT = "auth ok\n";
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin }) => {
        const result = await spawnWorkerBinary(
          bin,
          ["--model", "composer-2", "hello"],
          process.cwd(),
          { capture: true },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "auth ok\n");
      });
    } finally {
      if (previousStdout === undefined) {
        delete process.env.READYRUN_STUB_STDOUT;
      } else {
        process.env.READYRUN_STUB_STDOUT = previousStdout;
      }
    }
  });

  test("spawnWorkerBinary with capture and a timeout kills a Worker that never exits and reports timedOut", async () => {
    const previousHang = process.env.READYRUN_PROBE_HANG;
    process.env.READYRUN_PROBE_HANG = "1";
    try {
      await withRecordingPath(["readyrun-worker"], async ({ bin }) => {
        const started = Date.now();
        const result = await spawnWorkerBinary(
          bin,
          ["Print the output of `git rev-parse --show-toplevel` and nothing else."],
          process.cwd(),
          { capture: true, timeoutMs: 300 },
        );
        assert.equal(result.timedOut, true);
        assert.equal(result.stdout, process.cwd());
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 5_000, `expected a kill, took ${elapsed}ms`);
      });
    } finally {
      if (previousHang === undefined) {
        delete process.env.READYRUN_PROBE_HANG;
      } else {
        process.env.READYRUN_PROBE_HANG = previousHang;
      }
    }
  });
});
