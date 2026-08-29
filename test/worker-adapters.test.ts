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
      const unattendedRepo = await throwawayRepo();
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
          cwd: unattendedRepo.cwd,
          stdout: silent,
        });

        const unattended = await readReceipt(receiptPath);
        assert.equal(unattended.bin, "agent");
        assert.equal(unattended.argv[0], "-p");
        assert.equal(unattended.argv[1], "--model");
        assert.equal(unattended.argv[2], "composer-2");
        assert.ok(unattended.argv.includes("--yolo"));
        assert.match(unattended.argv.at(-1) ?? "", /52/);
        assert.notEqual(unattended.cwd, unattendedRepo.cwd);
        assert.match(unattended.cwd, /worktrees/);
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
            worker: cursor(),
            model: "composer-2",
          }),
          cap: 1,
          cwd: askRepo.cwd,
          stdout: silent,
        });

        const ask = await readReceipt(receiptPath);
        assert.ok(!ask.argv.includes("--yolo"));
        assert.ok(!ask.argv.includes("login"));
      } finally {
        await askRepo.cleanup();
      }
    });
  });

  test("a Claude Worker Adapter Run spawns the Worker with the prompt, model, Worktree cwd, and Claude's unattended flag", async () => {
    await withRecordingPath(["claude"], async ({ receiptPath }) => {
      const unattendedRepo = await throwawayRepo();
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
          cwd: unattendedRepo.cwd,
          stdout: silent,
        });

        const unattended = await readReceipt(receiptPath);
        assert.equal(unattended.bin, "claude");
        assert.equal(unattended.argv[0], "-p");
        assert.equal(unattended.argv[1], "--model");
        assert.equal(unattended.argv[2], "opus");
        assert.ok(unattended.argv.includes("--dangerously-skip-permissions"));
        assert.match(unattended.argv.at(-1) ?? "", /52/);
        assert.notEqual(unattended.cwd, unattendedRepo.cwd);
        assert.match(unattended.cwd, /worktrees/);
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
            worker: claude(),
            model: "opus",
          }),
          cap: 1,
          cwd: askRepo.cwd,
          stdout: silent,
        });

        const ask = await readReceipt(receiptPath);
        assert.ok(!ask.argv.includes("--dangerously-skip-permissions"));
        assert.ok(!ask.argv.includes("login"));
      } finally {
        await askRepo.cleanup();
      }
    });
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

  test("Doctor does not spawn the Worker or log it in when the binary is present", async () => {
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
