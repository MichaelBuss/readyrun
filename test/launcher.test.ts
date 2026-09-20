import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ConfigNotFoundError } from "../src/cli.ts";
import type { ReadyRunConfig } from "../src/config.ts";
import {
  capAnswer,
  capSuggestion,
  defaultEffort,
  headBaseState,
  launcher,
  type LauncherIO,
} from "../src/launcher.ts";
import { defineConfig, type RunOptions } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import {
  commitRepoFiles,
  git,
  onDisk,
  runBranches,
  throwawayRepo,
} from "./throwaway-repo.ts";
import { ticket } from "./tracker-adapter-contract.ts";

const exec = promisify(execFile);
const cancelled = Symbol("cancel");

type RecordedPrompt = {
  kind: "text" | "select" | "confirm";
  message: string;
  options?: unknown;
  initial?: unknown;
};

function scripted(answers: Array<string | boolean | symbol>): {
  io: LauncherIO;
  prompts: RecordedPrompt[];
} {
  const prompts: RecordedPrompt[] = [];
  let at = 0;
  const next = (): string | boolean | symbol => {
    const value = answers[at];
    at += 1;
    return value ?? cancelled;
  };
  const io: LauncherIO = {
    intro() {},
    outro() {},
    cancel() {},
    async text(options) {
      prompts.push({
        kind: "text",
        message: options.message,
        initial: options.initialValue,
      });
      return next() as string | symbol;
    },
    async select(options) {
      prompts.push({
        kind: "select",
        message: options.message,
        options: options.options,
        initial: options.initialValue,
      });
      return next() as never;
    },
    async confirm(options) {
      prompts.push({
        kind: "confirm",
        message: options.message,
        initial: options.initialValue,
      });
      return next() as boolean | symbol;
    },
  };
  return { io, prompts };
}

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

function launcherConfig(
  overrides: Partial<ReadyRunConfig> = {},
): ReadyRunConfig {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [
        ticket({ id: "52", title: "First up" }),
        ticket({ id: "54", title: "Blocked behind 52", blockedBy: ["52"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
    ...overrides,
  });
}

// A dated commit, so Run Branch enumeration can be asserted newest-first
// without hoping two commits land in different seconds.
async function commitDated(
  cwd: string,
  file: string,
  committerDate: string,
): Promise<void> {
  await writeFile(join(cwd, file), `${file}\n`);
  await exec("git", ["add", "--", file], { cwd });
  await exec("git", ["commit", "-m", file], {
    cwd,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: committerDate,
      GIT_AUTHOR_DATE: committerDate,
    },
  });
}

test("capSuggestion is the unblocked Frontier size, never below a list root's floor", () => {
  assert.equal(capSuggestion(7, undefined), 7);
  assert.equal(capSuggestion(2, { kind: "list", ids: ["1", "2", "3"] }), 3);
  assert.equal(capSuggestion(0, undefined), 1);
  assert.equal(capSuggestion(0, { kind: "list", ids: ["1"] }), 1);
});

test("capAnswer demands a whole number of at least 1", () => {
  assert.deepEqual(capAnswer("3"), { ok: true, cap: 3 });
  assert.equal(capAnswer("0").ok, false);
  assert.equal(capAnswer("-1").ok, false);
  assert.equal(capAnswer("two").ok, false);
  assert.equal(capAnswer("2.5").ok, false);
  assert.equal(capAnswer(undefined).ok, false);
  assert.equal(capAnswer("").ok, false);
});

test("headBaseState: a checkout with no Run Branches is a fresh Run", async () => {
  const repo = await throwawayRepo();
  try {
    assert.deepEqual(await headBaseState(repo.cwd), { kind: "fresh" });
  } finally {
    await repo.cleanup();
  }
});

test("headBaseState: HEAD parked on an unmerged Run Branch steers to the default branch", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitRepoFiles(repo.cwd, { "parked.txt": "parked\n" });
    const state = await headBaseState(repo.cwd);
    assert.equal(state.kind, "steer");
    assert.equal(
      state.kind === "steer" && state.branch,
      "readyrun/run-20260101-000000",
    );
    assert.equal(state.kind === "steer" && state.defaultBranch, "main");
  } finally {
    await repo.cleanup();
  }
});

test("headBaseState: HEAD on the default branch with an unmerged Run Branch offers it, newest first", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitDated(repo.cwd, "older.txt", "2026-01-01T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260102-000000"]);
    await commitDated(repo.cwd, "newer.txt", "2026-01-02T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    const state = await headBaseState(repo.cwd);
    assert.equal(state.kind, "pick");
    if (state.kind === "pick") {
      assert.deepEqual(
        state.unmerged.map((branch) => branch.name),
        [
          "readyrun/run-20260102-000000",
          "readyrun/run-20260101-000000",
        ],
      );
      assert.deepEqual(
        state.unmerged.map((branch) => branch.mergedIntoDefault),
        [false, false],
      );
    }
  } finally {
    await repo.cleanup();
  }
});

test("headBaseState: HEAD already containing the newest Run Branch is a fresh Run, and a merged Run Branch is never offered", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitRepoFiles(repo.cwd, { "reviewed.txt": "reviewed\n" });
    await git(repo.cwd, ["checkout", "main"]);
    await git(
      repo.cwd,
      ["merge", "--ff-only", "readyrun/run-20260101-000000"],
    );
    assert.deepEqual(await headBaseState(repo.cwd), { kind: "fresh" });
  } finally {
    await repo.cleanup();
  }
});

test("headBaseState: among unmerged Run Branches a merged one is never listed", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitDated(repo.cwd, "reviewed.txt", "2026-01-01T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    await git(
      repo.cwd,
      ["merge", "--ff-only", "readyrun/run-20260101-000000"],
    );
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260102-000000"]);
    await commitDated(repo.cwd, "parked.txt", "2026-01-02T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    const state = await headBaseState(repo.cwd);
    assert.equal(state.kind, "pick");
    if (state.kind === "pick") {
      assert.deepEqual(
        state.unmerged.map((branch) => branch.name),
        ["readyrun/run-20260102-000000"],
      );
    }
  } finally {
    await repo.cleanup();
  }
});

test("the launcher collects answers, renders the Plan, and hands the Run its options on confirm", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io, prompts } = scripted([
    "4",
    "unattended",
    "opus",
    "high",
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs.length, 1);
    const handed = runs[0];
    assert.equal(handed?.cap, 4);
    assert.equal(handed?.base, undefined);
    assert.equal(handed?.root, undefined);
    assert.equal(handed?.permissions, "unattended");
    assert.equal(handed?.model, "opus");
    assert.equal(handed?.effort, "high");
    assert.deepEqual(handed?.cwd, repo.cwd);
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["text", "select", "text", "select", "confirm"],
    );
    assert.equal(prompts[0]?.initial, "1");
    assert.equal(prompts[0]?.message.includes("Cap"), true);
    assert.equal(prompts[1]?.initial, "ask");
    assert.equal(prompts[2]?.initial, "composer-2");
    assert.equal(prompts[4]?.message.includes("Start this Run"), true);
    const plan = out.chunks.join("");
    const lines = plan.split("\n").filter(Boolean);
    assert.equal(lines[0], "Plan for this Run");
    assert.ok(lines.includes("Doctor: pass"));
    assert.ok(lines.includes("Frontier: 1 Ticket in pick order"));
    assert.ok(
      lines.includes(
        "Run with: readyrun run --max 4 --model opus --permissions unattended --effort high",
      ),
    );
    assert.deepEqual(await runBranches(repo.cwd), []);
    assert.equal(await onDisk(`${repo.cwd}/.readyrun`), false);
  } finally {
    await repo.cleanup();
  }
});

test("answers kept at their config defaults carry no flag", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io } = scripted(["1", "ask", "composer-2", defaultEffort, true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    const handed = runs[0];
    assert.equal(handed?.cap, 1);
    assert.equal(handed?.permissions, undefined);
    assert.equal(handed?.model, undefined);
    assert.equal(handed?.effort, undefined);
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1"));
  } finally {
    await repo.cleanup();
  }
});

test("a declined confirm starts no Run", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io } = scripted(["1", "ask", "composer-2", defaultEffort, false]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 1);
    assert.equal(runs.length, 0);
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("a cancelled prompt starts no Run", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io } = scripted([cancelled]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 1);
    assert.equal(runs.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a HEAD parked on an unmerged Run Branch preselects the default branch as the base", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io, prompts } = scripted([
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    "main",
    true,
  ]);
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitRepoFiles(repo.cwd, { "parked.txt": "parked\n" });
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.base, "main");
    const basePrompt = prompts.find(
      (prompt) => prompt.kind === "select" && prompt.initial === "main",
    );
    assert.notEqual(basePrompt, undefined);
    assert.equal(runs[0]?.cap, 1);
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1 --base main"));
  } finally {
    await repo.cleanup();
  }
});

test("the base picker offers unmerged Run Branches newest first and never a merged one", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const { io, prompts } = scripted([
    "2",
    "unattended",
    "composer-2",
    defaultEffort,
    "readyrun/run-20260102-000000",
    true,
  ]);
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitDated(repo.cwd, "reviewed.txt", "2026-01-01T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    await git(
      repo.cwd,
      ["merge", "--ff-only", "readyrun/run-20260101-000000"],
    );
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260102-000000"]);
    await commitDated(repo.cwd, "parked.txt", "2026-01-02T00:00:00Z");
    await git(repo.cwd, ["checkout", "main"]);
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.base, "readyrun/run-20260102-000000");
    const basePrompt = prompts[4];
    assert.equal(basePrompt?.kind, "select");
    const options = basePrompt?.options as Array<{ value: string }>;
    assert.deepEqual(
      options.map((option) => option.value),
      ["readyrun/run-20260102-000000", "__fresh__"],
    );
    assert.equal(basePrompt?.initial, "readyrun/run-20260102-000000");
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(
      lines.includes(
        "Run with: readyrun run --max 2 --base readyrun/run-20260102-000000 --permissions unattended",
      ),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a fresh Run with nothing to continue never asks for a base", async () => {
  const repo = await throwawayRepo();
  const runs: RunOptions[] = [];
  const { io, prompts } = scripted(["1", "ask", "composer-2", defaultEffort, true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: { write() { return true; } },
      loadConfig: async () => launcherConfig(),
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.base, undefined);
    assert.equal(
      prompts.some((prompt) => prompt.kind === "select" && prompt.message.includes("base")),
      false,
    );
  } finally {
    await repo.cleanup();
  }
});

test("with no config the launcher offers Init first, then continues", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: RunOptions[] = [];
  const inits: number[] = [];
  let loads = 0;
  const { io, prompts } = scripted([true, "1", "ask", "composer-2", defaultEffort, true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => {
        loads += 1;
        if (loads === 1) {
          throw new ConfigNotFoundError();
        }
        return launcherConfig();
      },
      init: async () => {
        inits.push(1);
        return 0;
      },
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(inits.length, 1);
    assert.equal(runs.length, 1);
    const initConfirm = prompts[0];
    assert.equal(initConfirm?.kind, "confirm");
    assert.equal(initConfirm?.message.includes("init"), true);
  } finally {
    await repo.cleanup();
  }
});

test("a declined Init starts nothing", async () => {
  const repo = await throwawayRepo();
  const runs: RunOptions[] = [];
  const inits: number[] = [];
  const { io } = scripted([false]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: { write() { return true; } },
      loadConfig: async () => {
        throw new ConfigNotFoundError();
      },
      init: async () => {
        inits.push(1);
        return 0;
      },
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 1);
    assert.equal(inits.length, 0);
    assert.equal(runs.length, 0);
  } finally {
    await repo.cleanup();
  }
});

test("a real Init hand-off assembles a Run from the config Init wrote", async () => {
  const repo = await throwawayRepo();
  const runs: RunOptions[] = [];
  const { io } = scripted([true, "1", "unattended", "composer-2", defaultEffort, true]);
  const href = (path: string): string =>
    pathToFileURL(
      join(fileURLToPath(new URL(".", import.meta.url)), path),
    ).href;
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: { write() { return true; } },
      init: async (options) => {
        await writeFile(
          join(options.cwd, "readyrun.config.ts"),
          `import { defineConfig } from ${JSON.stringify(href("../src/mod.ts"))};
import { memoryTracker, recordingWorker } from ${JSON.stringify(href("../src/testing/mod.ts"))};

export default defineConfig({
  tracker: memoryTracker({ tickets: [], ready: "unblocked", labels: [] }),
  worker: recordingWorker({ exitCode: 0 }),
  model: "composer-2",
});
`,
        );
        return 0;
      },
      run: async (options) => {
        runs.push(options);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.cap, 1);
    assert.equal(runs[0]?.permissions, "unattended");
  } finally {
    await repo.cleanup();
  }
});
