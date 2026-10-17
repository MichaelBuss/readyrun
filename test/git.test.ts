import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { captureRepoSnapshot, collectTicket, createTicketWorktree, describeEscape, headCommit, originRepository, WorktreeExistsError, WorktreeNotRemovedError } from "../src/git.ts";
import { commitNpmConsumer, commitRepoFiles, git, onDisk, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);

test("originRepository is owner/name from an ssh origin, preserving case", async () => {
  const repo = await throwawayRepo();
  try {
    await exec("git", [
      "-C",
      repo.cwd,
      "remote",
      "add",
      "origin",
      "git@github.com:Acme/Widgets.git",
    ]);
    assert.equal(await originRepository(repo.cwd), "Acme/Widgets");
  } finally {
    await repo.cleanup();
  }
});

test("originRepository is owner/name from an https origin", async () => {
  const repo = await throwawayRepo();
  try {
    await exec("git", [
      "-C",
      repo.cwd,
      "remote",
      "add",
      "origin",
      "https://github.com/Acme/Widgets.git",
    ]);
    assert.equal(await originRepository(repo.cwd), "Acme/Widgets");
  } finally {
    await repo.cleanup();
  }
});

test("originRepository is undefined when origin is missing", async () => {
  const repo = await throwawayRepo();
  try {
    assert.equal(await originRepository(repo.cwd), undefined);
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree checks out the Ticket's Branch in .readyrun/worktrees", async () => {
  const repo = await throwawayRepo();
  try {
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", await headCommit(repo.cwd));
    assert.equal(
      worktreePath,
      `${repo.cwd}/.readyrun/worktrees/readyrun-52`,
    );
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "branch",
      "--show-current",
    ]);
    assert.equal(stdout.trim(), "readyrun/52");
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree creates the Branch at the base commit it is given, not at the Consumer checkout's HEAD", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await headCommit(repo.cwd);
    await commitRepoFiles(repo.cwd, { "later.txt": "later\n" });
    const later = await headCommit(repo.cwd);

    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", base);

    assert.equal(await headCommit(worktreePath), base);
    await assert.rejects(exec("git", [
      "-C",
      worktreePath,
      "merge-base",
      "--is-ancestor",
      later,
      "HEAD",
    ]));
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree recreates a Worktree whose directory and Branch were deleted by hand", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await headCommit(repo.cwd);
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", base);
    await rm(worktreePath, { recursive: true, force: true });
    await exec("git", [
      "-C",
      repo.cwd,
      "update-ref",
      "-d",
      "refs/heads/readyrun/52",
    ]);

    assert.equal(
      await createTicketWorktree(repo.cwd, "readyrun/52", base),
      worktreePath,
    );
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree refuses a Branch that already exists, instead of a raw git error", async () => {
  const repo = await throwawayRepo();
  try {
    await exec("git", ["-C", repo.cwd, "branch", "readyrun/52"]);
    await assert.rejects(
      createTicketWorktree(repo.cwd, "readyrun/52", await headCommit(repo.cwd)),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeExistsError);
        assert.match(error.message, /already has a Worktree for branch readyrun\/52/);
        assert.match(
          error.message,
          /git worktree remove .*readyrun-52/,
        );
        assert.match(error.message, /git branch -D readyrun\/52/);
        assert.match(error.message, /start a new Run/);
        assert.doesNotMatch(error.message, /finish|continue|by hand/i);
        return true;
      },
    );
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree hands back a Worktree whose dependencies are not installed", async () => {
  const repo = await throwawayRepo();
  try {
    await commitNpmConsumer(repo.cwd);
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", await headCommit(repo.cwd));
    await assert.rejects(access(join(worktreePath, "node_modules")), {
      code: "ENOENT",
    });
  } finally {
    await repo.cleanup();
  }
});

test("collectTicket removes the Worktree, lands one merge, deletes the Ticket's Branch, and returns the Landing", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await headCommit(repo.cwd);
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", base);
    await commitRepoFiles(
      worktreePath,
      { "ticket-52.txt": "the Worker's work\n" },
      "Ticket 52",
    );
    const ticketTip = await git(repo.cwd, ["rev-parse", "refs/heads/readyrun/52"]);

    const landing = await collectTicket(repo.cwd, {
      runBranch: "readyrun/run-20260902-193300",
      branch: "readyrun/52",
      base,
      message: "Ticket 52: Fix the thing",
      worktree: worktreePath,
    });

    const runBranchTip = await git(repo.cwd, [
      "rev-parse",
      "refs/heads/readyrun/run-20260902-193300",
    ]);
    assert.deepEqual(landing, {
      runBranch: "readyrun/run-20260902-193300",
      mergeCommit: runBranchTip,
    });
    assert.equal(await onDisk(worktreePath), false);
    await assert.rejects(exec("git", [
      "-C",
      repo.cwd,
      "rev-parse",
      "--verify",
      "refs/heads/readyrun/52",
    ]));
    // One merge commit, two parents: the Run Branch tip it collected onto
    // first, the Ticket's Branch second (ADR 0028's first-parent shape).
    assert.equal(
      await git(repo.cwd, ["rev-parse", `${runBranchTip}^1`]),
      base,
    );
    assert.equal(
      await git(repo.cwd, ["rev-parse", `${runBranchTip}^2`]),
      ticketTip,
    );
    assert.match(
      await git(repo.cwd, ["log", "-1", "--format=%s", runBranchTip]),
      /^Ticket 52: Fix the thing$/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("collectTicket leaves no Run Branch behind when it cannot merge the Ticket's Branch, with the Worktree gone and the Branch surviving", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await headCommit(repo.cwd);
    // A branch named readyrun makes every ref under readyrun/ unwritable, so
    // the merge fails where it writes the Run Branch. The Ticket's own Branch
    // is named out of that collision, so the collect gets as far as the merge.
    const worktreePath = await createTicketWorktree(repo.cwd, "work/52", base);
    await commitRepoFiles(
      worktreePath,
      { "ticket-52.txt": "the Worker's work\n" },
      "Ticket 52",
    );
    await git(repo.cwd, ["branch", "readyrun"]);

    await assert.rejects(collectTicket(repo.cwd, {
      runBranch: "readyrun/run-20260902-193300",
      branch: "work/52",
      base,
      message: "Ticket 52: Fix the thing",
      worktree: worktreePath,
    }));

    await assert.rejects(exec("git", [
      "-C",
      repo.cwd,
      "rev-parse",
      "--verify",
      "refs/heads/readyrun/run-20260902-193300",
    ]));
    // Removed before the merge was attempted: a Branch cannot be deleted
    // while a Worktree still has it checked out (ADR 0029) — the ordering
    // invariant collectTicket owns.
    assert.equal(await onDisk(worktreePath), false);
    // The Branch survives, because the Ticket it belongs to is still on the
    // Frontier: collection did not happen (ADR 0033).
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/work/52"]);
  } finally {
    await repo.cleanup();
  }
});

test("collectTicket keeps the Worktree and merges nothing when the Worktree cannot be removed", async () => {
  const repo = await throwawayRepo();
  try {
    const base = await headCommit(repo.cwd);
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52", base);
    await writeFile(join(worktreePath, "left-behind.txt"), "untracked\n");

    await assert.rejects(
      collectTicket(repo.cwd, {
        runBranch: "readyrun/run-20260902-193300",
        branch: "readyrun/52",
        base,
        message: "Ticket 52: Fix the thing",
        worktree: worktreePath,
      }),
      WorktreeNotRemovedError,
    );

    assert.equal(await onDisk(worktreePath), true);
    await assert.rejects(exec("git", [
      "-C",
      repo.cwd,
      "rev-parse",
      "--verify",
      "refs/heads/readyrun/run-20260902-193300",
    ]));
    await git(repo.cwd, ["rev-parse", "--verify", "refs/heads/readyrun/52"]);
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree refuses a leftover Worktree directory even when the Branch does not exist", async () => {
  const repo = await throwawayRepo();
  try {
    const worktreePath = `${repo.cwd}/.readyrun/worktrees/readyrun-52`;
    await mkdir(worktreePath, { recursive: true });
    await assert.rejects(
      createTicketWorktree(repo.cwd, "readyrun/52", await headCommit(repo.cwd)),
      WorktreeExistsError,
    );
  } finally {
    await repo.cleanup();
  }
});

test("captureRepoSnapshot reads HEAD, the branch, porcelain without .readyrun/, and refs without the Ticket's Branch", async () => {
  const repo = await throwawayRepo();
  try {
    const head = await headCommit(repo.cwd);
    await writeFile(join(repo.cwd, "dirt.txt"), "the Consumer's\n");
    await mkdir(join(repo.cwd, ".readyrun"), { recursive: true });
    await writeFile(join(repo.cwd, ".readyrun", "own.txt"), "ReadyRun's\n");
    await git(repo.cwd, ["branch", "readyrun/52"]);
    await git(repo.cwd, ["branch", "elsewhere"]);

    const snapshot = await captureRepoSnapshot(repo.cwd, "readyrun/52");

    assert.equal(snapshot.head, head);
    assert.equal(snapshot.branch, "main");
    assert.deepEqual(snapshot.porcelain, ["?? dirt.txt"]);
    assert.deepEqual([...snapshot.refs.keys()], [
      "refs/heads/elsewhere",
      "refs/heads/main",
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("captureRepoSnapshot leaves the branch undefined on a detached checkout", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["checkout", "--detach"]);

    const snapshot = await captureRepoSnapshot(repo.cwd, "readyrun/52");

    assert.equal(snapshot.branch, undefined);
  } finally {
    await repo.cleanup();
  }
});

test("describeEscape is undefined when only the excluded Ticket Branch moved", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["branch", "readyrun/52"]);
    await git(repo.cwd, ["branch", "elsewhere"]);
    await writeFile(join(repo.cwd, "dirt.txt"), "the Consumer's\n");
    const before = await captureRepoSnapshot(repo.cwd, "readyrun/52");

    await git(repo.cwd, ["branch", "-f", "readyrun/52", "elsewhere"]);

    assert.equal(
      describeEscape(before, await captureRepoSnapshot(repo.cwd, "readyrun/52")),
      undefined,
    );
  } finally {
    await repo.cleanup();
  }
});

test("describeEscape names an advanced Consumer HEAD with both shas and the branch", async () => {
  const repo = await throwawayRepo();
  try {
    const before = await captureRepoSnapshot(repo.cwd, "readyrun/52");
    await git(repo.cwd, ["commit", "--allow-empty", "-m", "escape"]);

    const detail = describeEscape(
      before,
      await captureRepoSnapshot(repo.cwd, "readyrun/52"),
    );

    assert.match(
      detail ?? "",
      /^the Consumer's checkout advanced from [0-9a-f]{7} to [0-9a-f]{7} on main; ref refs\/heads\/main moved from [0-9a-f]{7} to [0-9a-f]{7}$/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("describeEscape omits the branch on an advanced detached checkout", async () => {
  const repo = await throwawayRepo();
  try {
    const before = await captureRepoSnapshot(repo.cwd, "readyrun/52");
    await git(repo.cwd, ["checkout", "--detach"]);
    await git(repo.cwd, ["commit", "--allow-empty", "-m", "escape"]);

    const detail = describeEscape(
      before,
      await captureRepoSnapshot(repo.cwd, "readyrun/52"),
    );

    assert.match(
      detail ?? "",
      /^the Consumer's checkout advanced from [0-9a-f]{7} to [0-9a-f]{7}$/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("describeEscape names porcelain entries that appeared, changed, or were cleared", async () => {
  const repo = await throwawayRepo();
  try {
    await writeFile(join(repo.cwd, "cleared.txt"), "dirt\n");
    const before = await captureRepoSnapshot(repo.cwd, "readyrun/52");
    await rm(join(repo.cwd, "cleared.txt"));
    await writeFile(join(repo.cwd, "README"), "changed\n");
    await writeFile(join(repo.cwd, "appeared.txt"), "new\n");

    const detail = describeEscape(
      before,
      await captureRepoSnapshot(repo.cwd, "readyrun/52"),
    );

    assert.match(
      detail ?? "",
      /uncommitted changes appeared in the Consumer's checkout \( M README, \?\? appeared\.txt\)/,
    );
    assert.match(
      detail ?? "",
      /uncommitted changes were cleared from the Consumer's checkout \(.{1,4}cleared\.txt\)/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("describeEscape names refs that were created or deleted, including remote-tracking refs", async () => {
  const repo = await throwawayRepo();
  try {
    await git(repo.cwd, ["branch", "elsewhere"]);
    const before = await captureRepoSnapshot(repo.cwd, "readyrun/52");
    await git(repo.cwd, ["branch", "somewhere-else"]);
    await git(repo.cwd, ["branch", "-D", "elsewhere"]);
    await git(repo.cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const detail = describeEscape(
      before,
      await captureRepoSnapshot(repo.cwd, "readyrun/52"),
    );

    assert.match(
      detail ?? "",
      /ref refs\/heads\/somewhere-else was created at [0-9a-f]{7}/,
    );
    assert.match(detail ?? "", /ref refs\/heads\/elsewhere was deleted/);
    assert.match(
      detail ?? "",
      /ref refs\/remotes\/origin\/main was created at [0-9a-f]{7}/,
    );
  } finally {
    await repo.cleanup();
  }
});
