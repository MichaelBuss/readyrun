import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  computePlan,
  defineConfig,
  type Plan,
  runPlan,
  type RunRuntime,
} from "../src/mod.ts";
import {
  createTrackerAdapter,
  type TrackerAdapter,
} from "../src/tracker-adapter.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { runBranches, throwawayRepo } from "./throwaway-repo.ts";
import { ticket } from "./tracker-adapter-contract.ts";

const silent = {
  write(_chunk?: string) {
    return true;
  },
};

function countingTracker(inner: TrackerAdapter): {
  adapter: TrackerAdapter;
  reads: { inspect: number; frontier: number; waiting: number };
} {
  const reads = { inspect: 0, frontier: 0, waiting: 0 };
  const adapter = createTrackerAdapter({
    async inspect() {
      reads.inspect += 1;
      return inner.inspect();
    },
    async frontier(root) {
      reads.frontier += 1;
      return inner.frontier(root);
    },
    async waiting(root) {
      reads.waiting += 1;
      return inner.waiting(root);
    },
    branchName: (item) => inner.branchName(item),
    promptCopy: (item) => inner.promptCopy(item),
    leaveFrontier: (item, landing) => inner.leaveFrontier(item, landing),
    tree: (root) => inner.tree(root),
  });
  return { adapter, reads };
}

function consumerConfig(
  tracker: TrackerAdapter,
  worker = recordingWorker({ exitCode: 0 }),
) {
  return defineConfig({
    tracker,
    worker,
    model: "composer-2",
  });
}

test("the Plan module no longer imports the Run's option shape", async () => {
  const source = await readFile(
    join(import.meta.dirname, "..", "src", "plan.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /from "\.\/run\.ts"/);
});

test("a refused Plan refuses the Run with no Tracker read and no Worker spawn", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const { adapter, reads } = countingTracker(
    memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["missing-label"],
      existingLabels: ["ready-for-agent"],
    }),
  );
  const chunks: string[] = [];
  try {
    const config = consumerConfig(adapter, worker);
    const plan = await computePlan({
      config,
      cap: 1,
      cwd: repo.cwd,
    });
    assert.ok(plan.doctorFailures.length > 0, "the Plan must carry the lie");
    const runtime: RunRuntime = {
      config,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    };
    const exitCode = await runPlan(plan, runtime);

    assert.equal(exitCode, 1);
    assert.match(chunks.join(""), /label "missing-label" does not exist/);
    assert.equal(reads.inspect, 1, "only the Plan's own Doctor read");
    assert.equal(reads.frontier, 1, "only the Plan's own Frontier read");
    assert.equal(worker.spawns.length, 0, "no Worker, not even the probe");
  } finally {
    await repo.cleanup();
  }
});

test("the loop's first pick is the Plan's Frontier; fresh reads resume after each Ticket", async () => {
  const repo = await throwawayRepo();
  const inner = memoryTracker({
    tickets: [
      ticket({ id: "52", title: "First up" }),
      ticket({ id: "54", title: "Blocked behind 52", blockedBy: ["52"] }),
    ],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const { adapter, reads } = countingTracker(inner);
  try {
    const plan = await computePlan({
      config: consumerConfig(adapter),
      cap: 2,
      cwd: repo.cwd,
    });
    assert.deepEqual(
      plan.frontier.map((entry) => entry.id),
      ["52"],
      "the Plan's snapshot holds only the unblocked Ticket",
    );
    const exitCode = await runPlan(plan, {
      config: consumerConfig(adapter),
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.equal(reads.frontier, 2, "the Plan's read plus one fresh read");
    assert.deepEqual(
      (await runBranches(repo.cwd)).length,
      1,
      "both Tickets landed on the Run Branch",
    );
  } finally {
    await repo.cleanup();
  }
});

test("the Run collects onto the Run Branch the Plan named", async () => {
  const repo = await throwawayRepo();
  const { adapter } = countingTracker(
    memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
  );
  try {
    const plan = await computePlan({
      config: consumerConfig(adapter),
      cap: 1,
      cwd: repo.cwd,
    });
    await runPlan(plan, {
      config: consumerConfig(adapter),
      cwd: repo.cwd,
      stdout: silent,
    });
    const branches = await runBranches(repo.cwd);
    assert.deepEqual(branches, [plan.runBranch]);
  } finally {
    await repo.cleanup();
  }
});
