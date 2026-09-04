import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createTrackerAdapter, defineConfig, run } from "../src/mod.ts";
import type { Landing } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  git,
  onDisk,
  runBranch,
  runBranches,
  throwawayRepo,
} from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

test("a Consumer's leaveFrontier override is told the Run Branch and the merge commit the Ticket landed as", async () => {
  const repo = await throwawayRepo();
  const told: {
    ticketId: string;
    landing: Landing;
    runBranchTipWhenTold: string;
  }[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
        async leaveFrontier(finished, landing) {
          told.push({
            ticketId: finished.id,
            landing,
            // Read as the Tracker is told, not afterwards: the merge commit it
            // names has to be on the Run Branch by then.
            runBranchTipWhenTold: await git(repo.cwd, [
              "rev-parse",
              `refs/heads/${landing.runBranch}`,
            ]),
          });
        },
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });

    assert.equal(exitCode, 0);
    const collected = await runBranch(repo.cwd);
    assert.deepEqual(told.map((call) => call.ticketId), ["52"]);
    assert.deepEqual(told[0]?.landing, {
      runBranch: collected,
      mergeCommit: await git(repo.cwd, ["rev-parse", `refs/heads/${collected}`]),
    });
    assert.equal(told[0]?.runBranchTipWhenTold, told[0]?.landing.mergeCommit);
  } finally {
    await repo.cleanup();
  }
});

test("a merge failure leaves the Ticket on the Frontier and tells the Tracker nothing", async () => {
  const repo = await throwawayRepo();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const told: string[] = [];
  const chunks: string[] = [];
  try {
    // A branch named readyrun makes every ref under readyrun/ unwritable, so
    // the merge fails where it writes the Run Branch. The Ticket's own Branch
    // is named out of that collision, so the Run gets as far as the merge.
    await git(repo.cwd, ["branch", "readyrun"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: createTrackerAdapter({
          frontier: () => inner.frontier(),
          branchName: (item) => `work/${item.id}`,
          leaveFrontier(item, landing) {
            told.push(item.id);
            return inner.leaveFrontier(item, landing);
          },
          promptCopy: (item) => inner.promptCopy(item),
          inspect: () => inner.inspect(),
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 2,
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(told, []);
    assert.deepEqual(
      (await inner.frontier()).map((item) => item.id),
      ["52", "57"],
    );
    assert.deepEqual(await runBranches(repo.cwd), []);
    // Gone before the merge was attempted: a Branch cannot be deleted while a
    // Worktree still has it checked out (ADR 0029).
    assert.equal(
      await onDisk(join(repo.cwd, ".readyrun", "worktrees", "work-52")),
      false,
    );
    const output = chunks.join("");
    assert.match(
      output,
      /Hard stop: Ticket 52 failed at git: ReadyRun could not merge the Ticket's Branch into the Run Branch/,
    );
    assert.match(output, /0 Tickets landed; no Run Branch was created/);
  } finally {
    await repo.cleanup();
  }
});
