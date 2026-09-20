import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computePlan,
  custom,
  defineConfig,
  doctor,
  preview,
  RunCapRequiredError,
} from "../src/mod.ts";
import type { ReadyRunConfig } from "../src/config.ts";
import { createTrackerAdapter } from "../src/tracker-adapter.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { withRecordingPath } from "./stub-worker.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  git,
  commitRepoFiles,
  onDisk,
  runBranches,
  throwawayRepo,
} from "./throwaway-repo.ts";

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

function lines(chunks: string[]): string[] {
  return chunks.join("").split("\n").filter(Boolean);
}

function frontierWorld() {
  return memoryTracker({
    tickets: [
      ticket({ id: "52", title: "First up" }),
      ticket({ id: "54", title: "Blocked behind 52", blockedBy: ["52"] }),
    ],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
}

function previewConfig(overrides: Partial<ReadyRunConfig> = {}): ReadyRunConfig {
  return defineConfig({
    tracker: frontierWorld(),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
    cap: 1,
    ...overrides,
  });
}

test("a preview prints the Plan read-only and starts nothing", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    const exitCode = await preview({
      config: previewConfig({ worker }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(
      lines(out.chunks).map((line) =>
        line.replace(
          /^Run Branch: readyrun\/run-\d{8}-\d{6} \(named when the Run starts\)$/,
          "Run Branch: <stamp>",
        )
      ),
      [
        "Run preview: nothing starts; this Plan is read-only",
        "Doctor: pass",
        "Frontier: 1 Ticket in pick order",
        "  1. 52 First up",
        "Waiting: 1 Ticket off the Frontier",
        "  54 waits on 52",
        `Base: ${base.slice(0, 7)} on main`,
        "Run Branch: <stamp>",
        "Cap: 1 Ticket from --max",
        "Cwd-fidelity probe: not run; the Run proves it at start",
        "Run with: readyrun run --max 1",
      ],
    );
    assert.match(
      out.chunks.join(""),
      /^Run Branch: readyrun\/run-\d{8}-\d{6} \(named when the Run starts\)$/m,
    );
    assert.deepEqual(worker.spawns, []);
    assert.deepEqual(await runBranches(repo.cwd), []);
    assert.equal(await onDisk(`${repo.cwd}/.readyrun`), false);
  } finally {
    await repo.cleanup();
  }
});

test("the preview's closing command is the exact equivalent of the flags it was given", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await git(repo.cwd, ["checkout", "-b", "side"]);
    await commitRepoFiles(repo.cwd, { "side.txt": "off the default branch\n" });
    await commitRepoFiles(repo.cwd, { "side2.txt": "one more\n" });
    await git(repo.cwd, ["checkout", "main"]);
    const exitCode = await preview({
      config: previewConfig({ cap: undefined }),
      base: "side~1",
      root: { kind: "list", ids: ["52", "54"] },
      model: "composer-2",
      permissions: "unattended",
      effort: "high",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    const command = lines(out.chunks).find((line) =>
      line.startsWith("Run with:")
    );
    assert.equal(
      command,
      "Run with: readyrun run --max 2 --base side~1 --ticket 52 54 --model composer-2 --permissions unattended --effort high",
    );
    assert.ok(
      lines(out.chunks).includes("Cap: 2 Tickets from the --ticket list's length"),
    );
    assert.ok(
      lines(out.chunks).find((line) => line.startsWith("Base: ") && line.includes("from --base side~1")),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a parent root names --root in the equivalent command", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await preview({
      config: previewConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "8", title: "The parent" }),
            ticket({ id: "11", title: "Child work", parent: "8" }),
            ticket({ id: "13", title: "Blocked child", parent: "8", blockedBy: ["11"] }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
      }),
      root: { kind: "parent", id: "8" },
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes("Run with: readyrun run --max 1 --root 8"),
    );
    assert.ok(lines(out.chunks).includes("Frontier: 1 Ticket in pick order"));
    assert.ok(lines(out.chunks).includes("  13 waits on 11"));
  } finally {
    await repo.cleanup();
  }
});

test("a cap resolved from config is named as its source", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await preview({
      config: previewConfig({ cap: 2 }),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes("Cap: 2 Tickets from config cap"));
  } finally {
    await repo.cleanup();
  }
});

test("a Doctor failure renders with the whole Plan, carries the command, and refuses with the exit code", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const exitCode = await preview({
      config: previewConfig({
        worker,
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["no-such-label"],
          existingLabels: [],
        }),
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    const rendered = lines(out.chunks);
    assert.ok(rendered.includes(
      'Doctor: label "no-such-label" does not exist on the Tracker. Check the Frontier selector.',
    ));
    assert.ok(rendered.some((line) => line.startsWith("Run with:")));
    assert.deepEqual(worker.spawns, []);
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("the preview skips the cwd-fidelity probe the Run's Doctor proves at start", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await withRecordingPath(["readyrun-worker"], async ({ receiptPath }) => {
      const exitCode = await preview({
        config: previewConfig({
          worker: custom({
            bin: "readyrun-worker",
            unattendedFlag: "--yolo",
          }),
        }),
        cap: 1,
        cwd: repo.cwd,
        stdout: out.stdout,
      });

      assert.equal(exitCode, 0);
      assert.doesNotMatch(out.chunks.join(""), /Probing Worker cwd fidelity/);
      assert.equal(await onDisk(receiptPath), false);
    });
  } finally {
    await repo.cleanup();
  }
});

test("Doctor with the same config does run the probe, so the skip belongs to the preview alone", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await withRecordingPath(["readyrun-worker"], async ({ receiptPath }) => {
      const exitCode = await doctor({
        config: previewConfig({
          worker: custom({
            bin: "readyrun-worker",
            unattendedFlag: "--yolo",
          }),
        }),
        cwd: repo.cwd,
        stdout: out.stdout,
      });

      assert.equal(exitCode, 0);
      assert.match(out.chunks.join(""), /Probing Worker cwd fidelity/);
      assert.equal(await onDisk(receiptPath), true);
    });
  } finally {
    await repo.cleanup();
  }
});

test("a Tracker Adapter that does not answer waiting Tickets is rendered as the refusal it is, not as nothing waiting", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await preview({
      config: previewConfig({
        tracker: createTrackerAdapter({
          frontier: () => Promise.resolve([ticket({ id: "52" })]),
        }),
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        "Waiting: This Tracker Adapter does not answer waiting Tickets. Pick a Tracker Adapter that does.",
      ),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a preview without any resolvable cap is refused, like a Run", async () => {
  await assert.rejects(
    () =>
      preview({
        config: previewConfig({ cap: undefined }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof RunCapRequiredError);
      return true;
    },
  );
});

test("the Plan is one computation a surface can render: computePlan answers what preview prints", async () => {
  const repo = await throwawayRepo();
  try {
    const plan = await computePlan({
      config: previewConfig(),
      cap: 1,
      cwd: repo.cwd,
    });

    assert.deepEqual(plan.doctorFailures, []);
    assert.deepEqual(plan.frontier.map((t) => t.id), ["52"]);
    assert.equal(plan.waiting.kind, "answered");
    assert.deepEqual(
      plan.waiting.kind === "answered"
        ? plan.waiting.tickets.map((t) => t.id)
        : [],
      ["54"],
    );
    assert.equal(plan.command, "readyrun run --max 1");
    assert.equal(plan.capSource, "--max");
  } finally {
    await repo.cleanup();
  }
});

test("a preview into a base git cannot resolve reports the failure and refuses", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await preview({
      config: previewConfig(),
      cap: 1,
      base: "no-such-ref",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(lines(out.chunks), [
      "Preview failed: ReadyRun cannot resolve --base no-such-ref to a commit in this checkout",
    ]);
  } finally {
    await repo.cleanup();
  }
});
