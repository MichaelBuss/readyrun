import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTrackerAdapter,
  defineConfig,
  run,
  UnknownConfigKeyError,
} from "../src/mod.ts";
import type { Ticket } from "../src/mod.ts";
import { recordingWorker } from "../src/testing/mod.ts";
import { landing, ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

// Stands in for a Tracker this package does not ship (Jira, GitLab, ...).
// Built only from createTrackerAdapter, the same public export a Consumer
// would import — no reach into tracker-adapter.ts, no src/testing/ fixture.
function jiraLikeTracker(tickets: Ticket[]) {
  const open = new Map(tickets.map((item) => [item.id, item] as const));
  return createTrackerAdapter({
    frontier() {
      return Promise.resolve(
        [...open.values()].sort((a, b) =>
          a.id.localeCompare(b.id, undefined, { numeric: true })
        ),
      );
    },
    branchName(item: Ticket) {
      return `readyrun/${item.id}`;
    },
    leaveFrontier(item: Ticket) {
      open.delete(item.id);
      return Promise.resolve();
    },
    promptCopy(item: Ticket) {
      return `Jira-like Ticket ${item.id}: ${item.title}`;
    },
  });
}

test("a Consumer can build a Tracker Adapter from the public entrypoint alone and run a Ticket through it", async () => {
  const repo = await throwawayRepo();
  const worker = recordingWorker({ exitCode: 0 });
  const tracker = jiraLikeTracker([ticket({ id: "52" })]);
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker,
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    assert.equal(worker.spawns.length, 1);
    assert.equal(worker.spawns[0]?.ticket.id, "52");

    const remaining = await tracker.frontier();
    assert.deepEqual(remaining, []);
  } finally {
    await repo.cleanup();
  }
});

test("createTrackerAdapter defaults branchName, leaveFrontier, promptCopy, and inspect when a Consumer only supplies frontier", async () => {
  const tracker = createTrackerAdapter({
    frontier() {
      return Promise.resolve([ticket({ id: "52" })]);
    },
  });

  assert.equal(tracker.branchName(ticket({ id: "52" })), "readyrun/52");
  await assert.doesNotReject(() =>
    tracker.leaveFrontier(ticket({ id: "52" }), landing())
  );
  assert.match(tracker.promptCopy(ticket({ id: "52" })), /52/);
  const inspected = await tracker.inspect();
  assert.equal(inspected.canExpressBlocking, true);
});

test("unknown keys on createTrackerAdapter are an error, not a silently ignored typo", () => {
  const methods = {
    frontier() {
      return Promise.resolve([]);
    },
    leaveFroniter() {
      return Promise.resolve();
    },
  };

  assert.throws(
    () => createTrackerAdapter(methods),
    (error: unknown) => {
      assert.ok(error instanceof UnknownConfigKeyError);
      assert.deepEqual([...error.keys], ["leaveFroniter"]);
      return true;
    },
  );
});
