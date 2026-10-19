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
  goFromTop,
  headBaseState,
  launcher,
  type LauncherIO,
} from "../src/launcher.ts";
import {
  defineConfig,
  type DeliveryPlan,
  type ForgePort,
  type Plan,
  type RunRuntime,
} from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { githubFromWorld } from "./github-http-fixture.ts";
import {
  commitRepoFiles,
  createRunBranch,
  git,
  onDisk,
  runBranches,
  throwawayClone,
  throwawayRepo,
} from "./throwaway-repo.ts";
import { ticket } from "./tracker-adapter-contract.ts";

const exec = promisify(execFile);
const cancelled = Symbol("cancel");

type RecordedPrompt = {
  kind: "text" | "select" | "confirm" | "multiSelect";
  message: string;
  options?: unknown;
  initial?: unknown;
};

// The Launcher's first question names what to assemble (ADR 0048). Scripts
// answer it here, once: by default every flow assembles a Run and the
// scripted answers feed the Run's own questions; a Delivery flow or a
// decline names its answer instead.
const assembleMessage = "What should ReadyRun assemble?";

function scripted(
  answers: Array<string | boolean | symbol>,
  assemble: string | symbol = "run",
): {
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
      // The assemble question is answered once, here — a Run, unless this
      // script names a Delivery or a decline.
      if (options.message === assembleMessage) {
        return assemble as never;
      }
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
    async multiSelect(options) {
      prompts.push({
        kind: "multiSelect",
        message: options.message,
        options: options.groups,
        initial: options.initialValues,
      });
      const value = next();
      // A multi-select answers an array; the script names the picks as one
      // comma- or space-joined string, and a symbol passes through.
      return (typeof value === "string"
        ? value.split(/[,\s]+/).filter((pick) => pick.length > 0)
        : value) as never;
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

// The commit-ish the Consumer named, as the Plan resolved it: a named base
// lands as a commit-ish base, the checkout default as the checkout kind.
function baseCommitish(plan: Plan | undefined): string | undefined {
  return plan?.base.kind === "commit-ish" ? plan.base.commitish : undefined;
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

// A tree worth rendering: one parent with pickable and waiting children, and
// one pickable Ticket with no parent. 41 itself carries no selector label, so
// it is never a candidate — a parent is never worked.
function treeConfig(): ReadyRunConfig {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [
        ticket({ id: "41", title: "The parent", labels: [] }),
        ticket({ id: "42", title: "First up", parent: "41" }),
        ticket({ id: "44", title: "Also ready", parent: "41" }),
        ticket({
          id: "54",
          title: "Blocked behind 52",
          blockedBy: ["52"],
          parent: "41",
        }),
        ticket({ id: "52", title: "Standalone" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
}

// The tree-refusing shape the fallback answers for: blocking cannot be
// expressed, so `tree` and `waiting` refuse while `frontier` still answers.
// 60 is off any named root, so the rootless and rooted Frontiers differ.
function fallbackConfig(): ReadyRunConfig {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [
        ticket({ id: "52", title: "First up" }),
        ticket({ id: "54", title: "Blocked behind 52", blockedBy: ["52"] }),
        ticket({ id: "60", title: "Unrelated" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      canExpressBlocking: false,
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
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

test("the assemble question goes first, and the tree question precedes the cap, rendering the tree grouped by parent with both halves", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    goFromTop,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => treeConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.root, undefined);
    const assemblePrompt = prompts[0];
    assert.equal(assemblePrompt?.kind, "select");
    assert.equal(assemblePrompt?.message, assembleMessage);
    assert.deepEqual(
      (assemblePrompt?.options as Array<{ value: string }>).map(
        (option) => option.value,
      ),
      ["run", "delivery"],
    );
    const treePrompt = prompts[1];
    assert.equal(treePrompt?.kind, "multiSelect");
    const groups = treePrompt?.options as Array<{
      label: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    }>;
    assert.deepEqual(
      groups.map((group) => group.label),
      ["From the top", "Ticket 41", "No parent"],
    );
    assert.equal(groups[0]?.options[0]?.value, goFromTop);
    assert.deepEqual(
      groups[1]?.options.map((option) => option.value),
      ["42", "44", "54"],
    );
    assert.deepEqual(
      groups[2]?.options.map((option) => option.value),
      ["52"],
    );
    const waiting = groups[1]?.options[2];
    assert.equal(waiting?.label, "Blocked behind 52");
    assert.equal(waiting?.hint, "waits on 52 — joins when it clears");
    assert.equal(groups[1]?.options[0]?.hint, undefined);
    const capPrompt = prompts[2];
    assert.equal(capPrompt?.initial, "3");
    assert.equal(
      prompts.some((prompt) => prompt.kind === "confirm" && prompt.message.includes("waits on")),
      false,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a multi-select across the tree emits the explicit --ticket list and confirms its waiting Tickets once", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    "42 44 54 52",
    true,
    "4",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => treeConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(runs[0]?.root, {
      kind: "list",
      ids: ["42", "44", "54", "52"],
    });
    const waitingConfirm = prompts[2];
    assert.equal(waitingConfirm?.kind, "confirm");
    assert.equal(
      waitingConfirm?.message,
      "#54 waits on 52 — joins when it clears. Include it in this Run?",
    );
    assert.equal(waitingConfirm?.initial, true);
    assert.equal(prompts[3]?.initial, "4");
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 4 --ticket 42 44 54 52"));
    assert.ok(lines.includes("Frontier: 3 Tickets in pick order"));
    assert.ok(lines.includes("  54 waits on 52"));
  } finally {
    await repo.cleanup();
  }
});

test("declining the waiting confirm drops the waiting Tickets from the list", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    "42 54",
    false,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => treeConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(runs[0]?.root, { kind: "list", ids: ["42"] });
    assert.equal(prompts[3]?.initial, "3");
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1 --ticket 42"));
  } finally {
    await repo.cleanup();
  }
});

test("declining every picked waiting Ticket re-asks the tree question", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    "54",
    false,
    goFromTop,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => treeConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.root, undefined);
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      [
        "select",
        "multiSelect",
        "confirm",
        "multiSelect",
        "text",
        "select",
        "text",
        "select",
        "confirm",
      ],
    );
  } finally {
    await repo.cleanup();
  }
});

test("a Tracker Adapter that refuses the tree falls back to the root flags as text prompts", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    "",
    "https://example.test/54",
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => fallbackConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(runs[0]?.root, { kind: "list", ids: ["54"] });
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["select", "text", "text", "text", "select", "text", "select", "confirm"],
    );
    assert.equal(prompts[3]?.initial, "1");
    const output = out.chunks.join("");
    assert.ok(output.includes("does not answer the tree"));
    assert.ok(output.includes("cannot express blocking"));
    assert.ok(output.includes("Run with: readyrun run --max 1 --ticket 54"));
  } finally {
    await repo.cleanup();
  }
});

test("the fallback names a parent with --root when one is given", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    "41",
    "",
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () =>
        defineConfig({
          tracker: memoryTracker({
            tickets: [
              ticket({ id: "41", title: "The parent", labels: [] }),
              ticket({ id: "42", title: "First up", parent: "41" }),
              ticket({
                id: "44",
                title: "Blocked behind 42",
                blockedBy: ["42"],
                parent: "41",
              }),
              ticket({ id: "60", title: "Unrelated" }),
            ],
            ready: "unblocked",
            labels: ["ready-for-agent"],
            canExpressBlocking: false,
          }),
          worker: recordingWorker({ exitCode: 0 }),
          model: "composer-2",
        }),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(runs[0]?.root, { kind: "parent", id: "41" });
    assert.equal(prompts[1]?.kind, "text");
    assert.equal(
      prompts[1]?.message.includes("parent"),
      true,
    );
    // The suggestion is the named parent's Frontier (42), not the rootless
    // one (42 and 60).
    assert.equal(prompts[3]?.initial, "1");
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1 --root 41"));
  } finally {
    await repo.cleanup();
  }
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
  const runs: Plan[] = [];
  let handedRuntime: RunRuntime | undefined;
  const { io, prompts } = scripted([
    goFromTop,
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
      run: async (plan, runtime) => {
        runs.push(plan);
        handedRuntime = runtime;
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(runs.length, 1);
    const handed = runs[0];
    assert.equal(handed?.cap, 4);
    assert.equal(handed?.base.kind, "checkout");
    assert.equal(handed?.root, undefined);
    assert.equal(handed?.settings.permissions, "unattended");
    assert.equal(handed?.model, "opus");
    assert.equal(handed?.settings.effort, "high");
    assert.deepEqual(handedRuntime?.cwd, repo.cwd);
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["select", "multiSelect", "text", "select", "text", "select", "confirm"],
    );
    assert.equal(prompts[1]?.kind, "multiSelect");
    assert.equal(prompts[2]?.initial, "1");
    assert.equal(prompts[2]?.message.includes("Cap"), true);
    assert.equal(prompts[3]?.initial, "ask");
    assert.equal(prompts[4]?.initial, "composer-2");
    assert.equal(prompts[6]?.message.includes("Start this Run"), true);
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
  const runs: Plan[] = [];
  const { io } = scripted([goFromTop, "1", "ask", "composer-2", defaultEffort, true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    const handed = runs[0];
    assert.equal(handed?.cap, 1);
    assert.equal(handed?.settings.permissions, "ask");
    assert.equal(handed?.model, undefined);
    assert.equal(handed?.settings.effort, undefined);
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1"));
  } finally {
    await repo.cleanup();
  }
});

test("the Effort question offers exactly the values the Worker Adapter declares", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([goFromTop, "1", "unattended", "composer-2", "high", true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () =>
        launcherConfig({
          worker: recordingWorker({ exitCode: 0, effortVocabulary: ["high"] }),
        }),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    const effortPrompt = prompts.find((prompt) => prompt.message === "Effort");
    assert.deepEqual(effortPrompt?.options, [
      { value: defaultEffort, label: "Worker default" },
      { value: "high", label: "High" },
    ]);
    assert.equal(runs[0]?.settings.effort, "high");
  } finally {
    await repo.cleanup();
  }
});

test("a Worker Adapter that declares no Effort is not asked", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([goFromTop, "1", "ask", "composer-2", true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () =>
        launcherConfig({
          worker: recordingWorker({ exitCode: 0, effortVocabulary: [] }),
        }),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["select", "multiSelect", "text", "select", "text", "confirm"],
    );
    assert.equal(runs[0]?.settings.effort, undefined);
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.includes("Run with: readyrun run --max 1"));
  } finally {
    await repo.cleanup();
  }
});

test("a Worker Adapter that declares a vocabulary but maps no flag is not asked either", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([goFromTop, "1", "ask", "composer-2", true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () =>
        launcherConfig({
          worker: createWorkerAdapter({ effortVocabulary: ["high"] }),
        }),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["select", "multiSelect", "text", "select", "text", "confirm"],
    );
    assert.equal(runs[0]?.settings.effort, undefined);
  } finally {
    await repo.cleanup();
  }
});

test("a declined confirm starts no Run", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io } = scripted([goFromTop, "1", "ask", "composer-2", defaultEffort, false]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
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
  const runs: Plan[] = [];
  const { io } = scripted([cancelled]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
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
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    goFromTop,
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
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(baseCommitish(runs[0]), "main");
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

test("the steer picker still offers the parked Run Branch, as an explicit base", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    goFromTop,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    "readyrun/run-20260101-000000",
    true,
  ]);
  try {
    await git(repo.cwd, ["checkout", "-b", "readyrun/run-20260101-000000"]);
    await commitRepoFiles(repo.cwd, { "parked.txt": "parked\n" });
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => launcherConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(baseCommitish(runs[0]), "readyrun/run-20260101-000000");
    const basePrompt = prompts.find((prompt) => prompt.kind === "select" && prompt.initial === "main");
    const options = basePrompt?.options as Array<{ value: string }>;
    assert.deepEqual(
      options.map((option) => option.value),
      ["main", "readyrun/run-20260101-000000"],
    );
  } finally {
    await repo.cleanup();
  }
});

test("the base picker offers unmerged Run Branches newest first and never a merged one", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const { io, prompts } = scripted([
    goFromTop,
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
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });

    assert.equal(exitCode, 0);
    assert.equal(baseCommitish(runs[0]), "readyrun/run-20260102-000000");
    const basePrompt = prompts.find(
      (prompt) =>
        prompt.kind === "select" &&
        (prompt.options as Array<{ value: string }>).some(
          (option) => option.value === "__fresh__",
        ),
    );
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
  const runs: Plan[] = [];
  const { io, prompts } = scripted([goFromTop, "1", "ask", "composer-2", defaultEffort, true]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: { write() { return true; } },
      loadConfig: async () => launcherConfig(),
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(runs[0]?.base.kind, "checkout");
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
  const runs: Plan[] = [];
  const inits: number[] = [];
  let loads = 0;
  const { io, prompts } = scripted([
    true,
    true,
    goFromTop,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
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
      run: async (plan, runtime) => {
        runs.push(plan);
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
    const runGate = prompts[1];
    assert.equal(runGate?.kind, "confirm");
    assert.equal(runGate?.message.includes("Start a Run"), true);
    assert.equal(runGate?.initial, true);
  } finally {
    await repo.cleanup();
  }
});

test("a declined Init starts nothing", async () => {
  const repo = await throwawayRepo();
  const runs: Plan[] = [];
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
      run: async (plan, runtime) => {
        runs.push(plan);
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

test("fresh off Init, a declined Run gate ends a success with no Run asked", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const runs: Plan[] = [];
  const inits: number[] = [];
  let loads = 0;
  const { io, prompts } = scripted([true, false]);
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
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(inits.length, 1);
    assert.equal(runs.length, 0);
    // Only the Init offer and the gate: the decline ends the flow before
    // the assemble question runs.
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["confirm", "confirm"],
    );
    assert.equal(prompts[1]?.message.includes("Start a Run"), true);
  } finally {
    await repo.cleanup();
  }
});

test("a cancelled Run gate after Init starts nothing", async () => {
  const repo = await throwawayRepo();
  const runs: Plan[] = [];
  let loads = 0;
  const { io } = scripted([true, cancelled]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: { write() { return true; } },
      loadConfig: async () => {
        loads += 1;
        if (loads === 1) {
          throw new ConfigNotFoundError();
        }
        return launcherConfig();
      },
      init: async () => 0,
      run: async (plan, runtime) => {
        runs.push(plan);
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

test("a real Init hand-off assembles a Run from the config Init wrote", async () => {
  const repo = await throwawayRepo();
  const runs: Plan[] = [];
  const { io } = scripted([
    true,
    true,
    goFromTop,
    "1",
    "unattended",
    "composer-2",
    defaultEffort,
    true,
  ]);
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
      run: async (plan, runtime) => {
        runs.push(plan);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.cap, 1);
    assert.equal(runs[0]?.settings.permissions, "unattended");
  } finally {
    await repo.cleanup();
  }
});

test("a Launcher-to-Run session reads the Tracker once per fact: the Run adds no start reads", async () => {
  const repo = await throwawayRepo();
  await exec("git", [
    "-C",
    repo.cwd,
    "remote",
    "add",
    "origin",
    "git@github.com:acme/widgets.git",
  ]);
  const { adapter, fixture } = githubFromWorld({
    tickets: [
      ticket({
        id: "52",
        title: "First up",
        url: "https://github.com/acme/widgets/issues/52",
      }),
      ticket({
        id: "54",
        title: "Blocked behind 52",
        blockedBy: ["52"],
        url: "https://github.com/acme/widgets/issues/54",
      }),
    ],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const out = capturing();
  const worker = recordingWorker({ exitCode: 0 });
  const { io } = scripted([
    goFromTop,
    "1",
    "ask",
    "composer-2",
    defaultEffort,
    true,
  ]);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () =>
        defineConfig({ tracker: adapter, worker, model: "composer-2" }),
      io,
    });

    assert.equal(exitCode, 0);
    // The session's candidate reads, one per fact: the tree the Launcher
    // renders, the Plan's Frontier in pick order (the same read Doctor's
    // verdict made), and the waiting half. The Run itself adds none at
    // start — its first pick is the Plan's snapshot (ADR 0039) — and the
    // cap stops the loop before any mid-Run re-read.
    const frontierReads = fixture.requests.filter((request) =>
      (JSON.parse(request.body ?? "{}") as { operationName?: string })
        .operationName === "Frontier"
    );
    assert.equal(frontierReads.length, 3);
    assert.equal(worker.spawns.length, 1);
    assert.equal((await runBranches(repo.cwd)).length, 1);
  } finally {
    await repo.cleanup();
  }
});

// The Delivery half of the Launcher (ADR 0048). The forge is injected, so
// the flow is priced against a scripted forge and a local upstream, never
// the network.
function fakeForge(): ForgePort & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    repository: "acme/widgets",
    created,
    async findPullRequest() {
      return undefined;
    },
    async createPullRequest(input) {
      created.push(input);
      return {
        number: created.length + 10,
        url: `https://github.com/acme/widgets/pull/${created.length + 10}`,
        head: input.head,
        base: input.base,
        draft: input.draft,
        state: "open" as const,
      };
    },
    async mergeMethods() {
      return ["merge"];
    },
  };
}

function deliveryConfig(): ReadyRunConfig {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [
        ticket({ id: "8", title: "Ship the thing" }),
        ticket({ id: "52", title: "Left side", parent: "8", labels: [] }),
        ticket({ id: "57", title: "Right side", parent: "8", labels: [] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      forge: "github",
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
}

test("cancelling the assemble question ends a success with nothing started", async () => {
  const repo = await throwawayRepo();
  const runs: Plan[] = [];
  const deliveries: unknown[] = [];
  const { io, prompts } = scripted([], cancelled);
  try {
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: capturing().stdout,
      loadConfig: async () => launcherConfig(),
      run: async (plan) => {
        runs.push(plan);
        return 0;
      },
      deliver: async () => {
        deliveries.push(1);
        return 0;
      },
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(runs.length, 0);
    assert.equal(deliveries.length, 0);
    assert.equal(prompts[0]?.message, assembleMessage);
  } finally {
    await repo.cleanup();
  }
});

test("the Delivery flow collects the mode and the Run Branch, renders the Plan, and hands the reconcile its Plan on confirm", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const out = capturing();
    const handed: DeliveryPlan[] = [];
    let handedRuntime: RunRuntime | undefined;
    const forge = fakeForge();
    const { io, prompts } = scripted(
      ["family-pr", runBranch, true],
      "delivery",
    );
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: out.stdout,
      loadConfig: async () => deliveryConfig(),
      deliver: async (plan, runtime) => {
        handed.push(plan);
        handedRuntime = runtime;
        return 0;
      },
      forge,
      io,
    });
    assert.equal(exitCode, 0);
    assert.equal(handed.length, 1);
    assert.deepEqual(handed[0]?.doctorFailures, []);
    assert.equal(handed[0]?.mode, "family-pr");
    assert.equal(handed[0]?.branch, runBranch);
    assert.equal(handedRuntime?.cwd, repo.cwd);
    // The questions: assemble, mode, branch, publish confirm.
    assert.deepEqual(
      prompts.map((prompt) => prompt.kind),
      ["select", "select", "select", "confirm"],
    );
    assert.deepEqual(
      (prompts[1]?.options as Array<{ value: string }>).map(
        (option) => option.value,
      ),
      ["family-pr", "stack", "main"],
    );
    assert.equal((prompts[2]?.options as Array<{ value: string }>).length, 1);
    assert.equal(prompts[2]?.initial, runBranch);
    // The Plan rendered read-only before the confirm.
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.equal(lines[0], "Plan for this Delivery");
    assert.ok(lines.includes("Doctor: pass"));
    assert.ok(
      lines.some((line) =>
        line.startsWith("Publication: readyrun/deliver/8 at ") &&
        line.endsWith("→ main")
      ),
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("a declined publish starts no Delivery", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
    ]);
    const deliveries: DeliveryPlan[] = [];
    const { io } = scripted(["family-pr", runBranch, false], "delivery");
    const exitCode = await launcher({
      cwd: repo.cwd,
      stdout: capturing().stdout,
      loadConfig: async () => deliveryConfig(),
      deliver: async (plan) => {
        deliveries.push(plan);
        return 0;
      },
      forge: fakeForge(),
      io,
    });
    assert.equal(exitCode, 1);
    assert.equal(deliveries.length, 0);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("with no Run Branch to deliver, the Delivery flow says so and stops", async () => {
  const repo = await throwawayRepo();
  const deliveries: DeliveryPlan[] = [];
  const { io, prompts } = scripted(["family-pr"], "delivery");
  const exitCode = await launcher({
    cwd: repo.cwd,
    stdout: capturing().stdout,
    loadConfig: async () => deliveryConfig(),
    deliver: async (plan) => {
      deliveries.push(plan);
      return 0;
    },
    forge: fakeForge(),
    io,
  });
  assert.equal(exitCode, 1);
  assert.equal(deliveries.length, 0);
  assert.deepEqual(
    prompts.map((prompt) => prompt.kind),
    ["select", "select"],
  );
});
