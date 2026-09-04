import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defineConfig, doctor, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitRepoFiles, git, runBranch, runBranches, throwawayRepo } from "./throwaway-repo.ts";

const dirtyWarning =
  "Warning: uncommitted changes in the primary checkout reach no Worktree";

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

function config() {
  return defineConfig({
    tracker: memoryTracker({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
}

test("a Run names the base commit and the Run Branch before it claims a Ticket, and says nothing else about a clean base on the default branch", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lines(out.chunks), [
      "Doctor",
      `Base: ${base.slice(0, 7)} on main`,
      `Run Branch: ${await runBranch(repo.cwd)}`,
      "Frontier",
      "Worktree",
      "Ticket 52  Ticket 52  1/1  readyrun/52",
      "Worker",
      "Run complete: cap of 1 Ticket reached; the Frontier may still hold work",
      `1 Ticket landed on ${await runBranch(repo.cwd)}, cut from ${
        base.slice(0, 7)
      }.`,
      `Continue with: readyrun run --max 1 --base ${await runBranch(repo.cwd)}`,
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("a Run calls out a base that is not the default branch", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await git(repo.cwd, ["checkout", "-b", "feature-x"]);
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        `Base: ${base.slice(0, 7)} on feature-x; not the default branch (main)`,
      ),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a dirty primary checkout warns that those changes reach no Worktree, and the Run starts anyway", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await writeFile(join(repo.cwd, "scratch.txt"), "not committed\n");

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(lines(out.chunks).includes(dirtyWarning));
    assert.ok(lines(out.chunks).includes("Ticket 52  Ticket 52  1/1  readyrun/52"));
    await git(repo.cwd, ["rev-parse", "--verify", await runBranch(repo.cwd)]);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor discloses the base a Run would start from, and names no Run Branch because it creates none", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await doctor({
      config: config(),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lines(out.chunks), [
      "Doctor",
      `Base: ${base.slice(0, 7)} on main`,
      "Frontier",
      "Next Ticket: 52",
    ]);
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor and a Run disclose a dirty, non-default base in the same words", async () => {
  const repo = await throwawayRepo();
  const doctorOut = capturing();
  const runOut = capturing();
  try {
    await git(repo.cwd, ["checkout", "-b", "feature-x"]);
    await writeFile(join(repo.cwd, "scratch.txt"), "not committed\n");
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    const baseLine =
      `Base: ${base.slice(0, 7)} on feature-x; not the default branch (main)`;

    const doctorExit = await doctor({
      config: config(),
      cwd: repo.cwd,
      stdout: doctorOut.stdout,
    });
    const runExit = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: runOut.stdout,
    });

    assert.equal(doctorExit, 0);
    assert.equal(runExit, 0);
    assert.deepEqual(lines(doctorOut.chunks), [
      "Doctor",
      baseLine,
      dirtyWarning,
      "Frontier",
      "Next Ticket: 52",
    ]);
    assert.deepEqual(lines(runOut.chunks), [
      "Doctor",
      baseLine,
      dirtyWarning,
      `Run Branch: ${await runBranch(repo.cwd)}`,
      "Frontier",
      "Worktree",
      "Ticket 52  Ticket 52  1/1  readyrun/52",
      "Worker",
      "Run complete: cap of 1 Ticket reached; the Frontier may still hold work",
      `1 Ticket landed on ${await runBranch(repo.cwd)}, cut from ${
        base.slice(0, 7)
      }.`,
      `Continue with: readyrun run --max 1 --base ${await runBranch(repo.cwd)}`,
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("a base named by --base is disclosed as that commit, attributed to the flag rather than to a branch the Consumer is not on", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await git(repo.cwd, ["checkout", "-b", "side"]);
    await commitRepoFiles(repo.cwd, { "side.txt": "off the default branch\n" });
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await git(repo.cwd, ["checkout", "main"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      base: "side",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(`Base: ${base.slice(0, 7)} from --base side`),
    );
  } finally {
    await repo.cleanup();
  }
});

// The callout exists to catch a base nobody meant. A base the Consumer typed
// was meant, so measuring it against the default branch is noise.
test("a base named by --base is not called out for differing from the default branch", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    await git(repo.cwd, ["checkout", "-b", "side"]);
    await commitRepoFiles(repo.cwd, { "side.txt": "off the default branch\n" });
    await git(repo.cwd, ["checkout", "main"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      base: "side",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.doesNotMatch(out.chunks.join(""), /not the default branch/);
  } finally {
    await repo.cleanup();
  }
});

test("a detached checkout is disclosed as the commit it is, and is not told it differs from a branch it may be sitting on", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await git(repo.cwd, ["checkout", "--detach", base]);

    const exitCode = await doctor({
      config: config(),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        `Base: ${base.slice(0, 7)} (detached HEAD); the default branch is main`,
      ),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a checkout with no commit to start from leaves Doctor with no base to disclose, rather than failing it", async () => {
  const repo = await throwawayRepo({ commits: false });
  const out = capturing();
  try {
    const exitCode = await doctor({
      config: config(),
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lines(out.chunks), [
      "Doctor",
      "Frontier",
      "Next Ticket: 52",
    ]);
  } finally {
    await repo.cleanup();
  }
});
