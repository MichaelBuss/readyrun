import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defineConfig,
  doctor,
  preview,
  run,
  type PlanInput,
} from "../src/mod.ts";
import { markerGaps, writeMarkerGaps } from "../src/merge-marker.ts";
import type { TrackerAdapter } from "../src/tracker-adapter.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { landing, ticket } from "./tracker-adapter-contract.ts";
import {
  createRunBranch,
  git,
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

// A Tracker whose Frontier holds Ticket 53 unblocked through the Tracker's
// own transition — 52 left the Frontier — while the Tracker's `blockedBy`
// relation between them still exists. Exactly the cross-Run shape ADR 0050
// discloses: the Tracker says unblocked; whether the base holds the marker
// is nobody else's to know.
async function unblockedThroughTransition(): Promise<TrackerAdapter> {
  const tracker = memoryTracker({
    tickets: [
      ticket({ id: "52" }),
      ticket({ id: "53", blockedBy: ["52"] }),
    ],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const [finished] = await tracker.frontier();
  assert.ok(finished);
  await tracker.leaveFrontier(finished, landing());
  return tracker;
}

function config(tracker: TrackerAdapter): PlanInput["config"] {
  return defineConfig({
    tracker,
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
}

// The one warning, wherever the disclosure renders: it names the Ticket, the
// blocker, and the base in marker terms, states its own blindness by naming
// the landings that leave no marker, and never says the work is missing.
function markerGapLine(base: string): string {
  return `Warning: the Tracker says Ticket 53 is unblocked, but base ${
    base.slice(0, 7)
  } does not contain Ticket 52's merge marker on its first-parent history. Best-effort: a squash, a family Delivery pull request, a hand merge that rewrote messages, or a human-implemented blocker leaves no marker, so a missing marker is a question, not an answer — it never means the work is missing.`;
}

test("a Run whose base lacks a landed blocker's marker warns in marker terms and starts anyway", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(await unblockedThroughTransition()),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes(markerGapLine(base)));
    // A disclosure never gates: the Ticket the Tracker calls unblocked was
    // picked and landed.
    assert.equal(await runBranches(repo.cwd).then((refs) => refs.length), 1);
  } finally {
    await repo.cleanup();
  }
});

test("a base whose first-parent history carries the marker starts with no marker disclosure", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    // A Run Branch the way a finished Run leaves one: its merge commit is
    // the marker, and a continuation Run based on it contains the work.
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "the blocker's work" },
    ]);

    const exitCode = await run({
      config: config(await unblockedThroughTransition()),
      cap: 1,
      base: runBranch,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.doesNotMatch(out.chunks.join(""), /merge marker/);
  } finally {
    await repo.cleanup();
  }
});

test("a marker reachable only off the first-parent line does not count as present", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    // The marker rides a merge's second parent, the way Worker-authored
    // commits do: reachable in the full history, never on the first-parent
    // line the walk reads.
    await git(repo.cwd, ["checkout", "-b", "side"]);
    await git(repo.cwd, ["commit", "--allow-empty", "-m", "Ticket 52: hidden"]);
    await git(repo.cwd, ["checkout", "main"]);
    await git(repo.cwd, ["merge", "--no-ff", "side", "-m", "integration"]);
    await git(repo.cwd, ["branch", "-D", "side"]);
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    // The precondition is the point: the marker is in the history at all.
    assert.match(
      await git(repo.cwd, ["log", "--format=%s"]),
      /^Ticket 52: hidden$/m,
    );

    const exitCode = await run({
      config: config(await unblockedThroughTransition()),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes(markerGapLine(base)));
  } finally {
    await repo.cleanup();
  }
});

test("the preview renders the same warning, in the same words", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await preview({
      config: config(await unblockedThroughTransition()),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes(markerGapLine(base)));
  } finally {
    await repo.cleanup();
  }
});

test("the preview renders the warning even when Doctor would refuse the Run", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    // The refusal: the selector names a label the Tracker does not have.
    const tracker = memoryTracker({
      tickets: [
        ticket({ id: "52" }),
        ticket({ id: "53", blockedBy: ["52"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      existingLabels: ["other"],
    });
    const [finished] = await tracker.frontier();
    assert.ok(finished);
    await tracker.leaveFrontier(finished, landing());

    const exitCode = await preview({
      config: config(tracker),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    // A refused Plan is computed whole: the disclosure rides it anyway.
    assert.ok(lines(out.chunks).includes(markerGapLine(base)));
  } finally {
    await repo.cleanup();
  }
});

test("Doctor renders the same warning, in the same words", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await doctor({
      config: config(await unblockedThroughTransition()),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes(markerGapLine(base)));
  } finally {
    await repo.cleanup();
  }
});

// The walk is best-effort by contract (ADR 0050): git that cannot answer
// leaves the disclosure silent rather than failing the Plan.
test("a history walk that cannot answer renders no warning and no failure", async () => {
  const nowhere = await mkdtemp(join(tmpdir(), "marker-walk-"));
  try {
    const out = capturing();
    const gaps = await markerGaps(nowhere, "HEAD", [
      ticket({ id: "53", leftFrontierBlockers: ["52"] }),
    ]);
    assert.deepEqual(gaps, []);
    writeMarkerGaps(out.stdout, gaps);
    assert.deepEqual(out.chunks, []);
  } finally {
    await rm(nowhere, { recursive: true, force: true });
  }
});

test("a Frontier whose Tickets answer no left-the-Frontier blockers walks no history", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const tracker = memoryTracker({
      tickets: [
        ticket({ id: "53", blockedBy: ["52"] }),
        ticket({ id: "52" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    // 52 is picked first; nothing on the Frontier ever had a blocker leave.
    const exitCode = await run({
      config: config(tracker),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.doesNotMatch(out.chunks.join(""), /merge marker/);
  } finally {
    await repo.cleanup();
  }
});
