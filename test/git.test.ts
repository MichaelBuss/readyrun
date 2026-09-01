import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { createTicketWorktree, originRepository, WorktreeExistsError } from "../src/git.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

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
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52");
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

test("createTicketWorktree refuses a Branch that already exists, instead of a raw git error", async () => {
  const repo = await throwawayRepo();
  try {
    await exec("git", ["-C", repo.cwd, "branch", "readyrun/52"]);
    await assert.rejects(
      createTicketWorktree(repo.cwd, "readyrun/52"),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeExistsError);
        assert.match(error.message, /already has a Worktree for branch readyrun\/52/);
        return true;
      },
    );
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
      createTicketWorktree(repo.cwd, "readyrun/52"),
      WorktreeExistsError,
    );
  } finally {
    await repo.cleanup();
  }
});
