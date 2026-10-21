import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTrackerAdapter, defineConfig, run } from "../src/mod.ts";
import type { Landing } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  commitWorkerWork,
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

test("a merge failure leaves the Ticket's Branch holding the work, the Ticket on the Frontier, and the Tracker told nothing", async () => {
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
    // The Branch survives with the Worker's commits on it: the collect deletes
    // it only after the merge's ref write succeeds, and that write failed. The
    // report names it, because the Worktree is gone and nothing landed — it is
    // all that holds the work (ADR 0049).
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/work/52"]);
    assert.match(
      output,
      /Ticket 52's Branch work\/52 survived the failed merge and holds the Worker's commits/,
    );
    assert.match(
      output,
      /Recover the work from that Branch or delete it before the Ticket is picked again/,
    );
    // Nothing to keep and nothing to prescribe: no Worktree line, and the
    // instruction is about the surviving Branch, never a git workflow.
    assert.doesNotMatch(output, /Worktree kept at/);
    assert.doesNotMatch(output, /push|git (merge|branch|rebase|cherry-pick)/);
  } finally {
    await repo.cleanup();
  }
});

test("a merge failure on a later Ticket still names the standing Run Branch and its surviving Branch", async () => {
  const repo = await throwawayRepo();
  const inner = memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const told: string[] = [];
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: createTrackerAdapter({
          frontier: () => inner.frontier(),
          branchName: (item) => `work/${item.id}`,
          leaveFrontier(item, landing) {
            told.push(item.id);
            const done = inner.leaveFrontier(item, landing);
            // After the first Ticket lands, a stale lock on the Run Branch ref
            // makes the second Ticket's merge fail where it writes the Run
            // Branch, with a landing already behind it.
            if (told.length === 1) {
              return done.then(() =>
                writeFile(
                  join(
                    repo.cwd,
                    ".git",
                    "refs",
                    "heads",
                    `${landing.runBranch}.lock`,
                  ),
                  "",
                ),
              );
            }
            return done;
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
    assert.deepEqual(told, ["52"]);
    const output = chunks.join("");
    assert.match(
      output,
      /Hard stop: Ticket 57 failed at git: ReadyRun could not merge the Ticket's Branch into the Run Branch/,
    );
    // The landing line stays truthful: the first Ticket's Run Branch stands.
    assert.match(output, /1 Ticket landed on readyrun\/run-/);
    assert.match(
      output,
      /Ticket 57's Branch work\/57 survived the failed merge and holds the Worker's commits/,
    );
    // The landed Ticket's Branch is gone; the failed one survives with the work.
    await assert.rejects(
      git(repo.cwd, ["rev-parse", "--verify", "refs/heads/work/52"]),
    );
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/work/57"]);
  } finally {
    await repo.cleanup();
  }
});

test("a Branch-delete failure after the merge landed names no surviving Branch", async () => {
  const repo = await throwawayRepo();
  const chunks: string[] = [];
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: createWorkerAdapter({
          async spawn(request) {
            await commitWorkerWork(request);
            // A stale lock on the Ticket's own Branch ref fails the collect's
            // delete — the window after the merge's ref write succeeded, where
            // the Landing already exists. The report must not claim the merge
            // failed or the Branch holds the work: it does not, and it landed.
            await writeFile(
              join(repo.cwd, ".git", "refs", "heads", "readyrun", "52.lock"),
              "",
            );
            return { exitCode: 0 };
          },
        }),
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

    assert.equal(exitCode, 1);
    const output = chunks.join("");
    assert.doesNotMatch(output, /survived the failed merge/);
    // The report reads as it did before this report gained the sentence.
    assert.match(
      output,
      /Hard stop: Ticket 52 failed at git: ReadyRun could not merge the Ticket's Branch into the Run Branch/,
    );
    // The merge did land: the Run Branch ref exists, and the failed delete
    // leaves the Ticket's Branch behind with nothing to recover.
    assert.equal((await runBranches(repo.cwd)).length, 1);
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/readyrun/52"]);
  } finally {
    await repo.cleanup();
  }
});
