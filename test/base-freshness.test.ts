import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunBase } from "../src/git.ts";
import { defineConfig, doctor, preview, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import {
  commitRepoFiles,
  git,
  runBranches,
  throwawayClone,
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

// The canonical forgotten pull: the upstream moved two commits ahead, and the
// Consumer fetched — the tip's objects are local — but never pulled.
async function staleClone() {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
  await commitRepoFiles(up.cwd, { "two.txt": "two\n" });
  await git(repo.cwd, ["fetch", "origin"]);
  return { up, repo };
}

test("a base behind a fetched origin tip is resolved stale, with the gap counted", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
    await commitRepoFiles(up.cwd, { "two.txt": "two\n" });
    const tip = await git(up.cwd, ["rev-parse", "HEAD"]);
    // The forgotten pull: fetched, so the tip's objects are local, but HEAD
    // never moved onto them.
    await git(repo.cwd, ["fetch", "origin"]);

    const base = await resolveRunBase(repo.cwd);

    assert.deepEqual(base.freshness, { kind: "stale", defaultBranch: "main", tip, behind: 2 });
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a tip whose objects were never fetched still reads stale, with the gap left to the two SHAs", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
    const tip = await git(up.cwd, ["rev-parse", "HEAD"]);

    const base = await resolveRunBase(repo.cwd);

    assert.deepEqual(base.freshness, { kind: "stale", defaultBranch: "main", tip, behind: undefined });
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a base at origin's tip is fresh, and a base containing it is silent too", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    const base = await resolveRunBase(repo.cwd);
    assert.equal(base.freshness?.kind, "fresh");

    // Ahead: the checkout holds commits origin does not, which contain the tip.
    await commitRepoFiles(repo.cwd, { "ahead.txt": "local only\n" });
    const ahead = await resolveRunBase(repo.cwd);
    assert.equal(ahead.freshness?.kind, "fresh");
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("freshness is not a meaningful question off the default branch, and skips silently", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
    // A feature branch standing still while main moves: no verdict, the
    // non-default callout already discloses it.
    await git(repo.cwd, ["checkout", "-b", "feature-x"]);
    const feature = await resolveRunBase(repo.cwd);
    assert.equal(feature.freshness, undefined);

    // A detached HEAD is a deliberate act the disclosure already names.
    const detachedAt = await git(repo.cwd, ["rev-parse", "HEAD"]);
    await git(repo.cwd, ["checkout", "--detach", detachedAt]);
    const detached = await resolveRunBase(repo.cwd);
    assert.equal(detached.freshness, undefined);

    // A commit-ish that does not name the default branch is measured against
    // nothing (ADR 0034), the continuation Run's shape included.
    await git(repo.cwd, ["checkout", "main"]);
    const commitish = await resolveRunBase(repo.cwd, "HEAD");
    assert.equal(commitish.freshness, undefined);
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("--base naming the default branch itself is probed, even from another branch", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
    const tip = await git(up.cwd, ["rev-parse", "HEAD"]);
    await git(repo.cwd, ["fetch", "origin"]);
    await git(repo.cwd, ["checkout", "-b", "feature-x"]);

    const base = await resolveRunBase(repo.cwd, "main");

    assert.deepEqual(base.freshness, { kind: "stale", defaultBranch: "main", tip, behind: 1 });
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a checkout with no origin remote has nothing to compare against and skips silently", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, { "one.txt": "one\n" });

    const base = await resolveRunBase(repo.cwd);

    assert.equal(base.freshness, undefined);
  } finally {
    await repo.cleanup();
  }
});

test("a probe that cannot reach origin degrades to an unknown verdict naming why", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    await git(repo.cwd, ["remote", "set-url", "origin", "/nonexistent/readyrun-upstream"]);

    const base = await resolveRunBase(repo.cwd);

    assert.equal(base.freshness?.kind, "unknown");
    assert.match(
      (base.freshness as { reason: string }).reason,
      /does not appear to be a git repository/,
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a remote with no branch matching the locally resolved default branch warns like an outage", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  try {
    // The remote stops holding the branch the checkout resolves as default:
    // origin/HEAD still answers main, but ls-remote answers empty.
    await git(up.cwd, ["branch", "-m", "main", "trunk"]);

    const base = await resolveRunBase(repo.cwd);

    assert.deepEqual(base.freshness, {
      kind: "unknown",
      defaultBranch: "main",
      reason: "origin has no branch named main",
    });
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a Run whose unnamed base is stale refuses, naming the gap and --allow-stale-base", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    const baseSha = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(lines(out.chunks), [
      "Doctor",
      `Doctor: Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history. Pull first, or pass --allow-stale-base to start from it anyway.`,
    ]);
    // Refused before anything was created: no Run Branch, no Ticket worked.
    assert.deepEqual(await runBranches(repo.cwd), []);
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("--allow-stale-base downgrades the gate to the warning a named base gets, and does not skip the probe", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    const baseSha = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      allowStaleBase: true,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        `Warning: Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history. Pull first`,
      ),
    );
    assert.ok(
      lines(out.chunks).includes("Ticket 52  Ticket 52  1/1  readyrun/52"),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a stale base named by --base is warned, never gated", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    const baseSha = await git(repo.cwd, ["rev-parse", "main"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      base: "main",
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        `Warning: Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history. Pull first`,
      ),
    );
    assert.ok(
      lines(out.chunks).includes("Ticket 52  Ticket 52  1/1  readyrun/52"),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("a gap that cannot be counted is named by the two SHAs", async () => {
  const up = await throwawayRepo();
  const repo = await throwawayClone(up.cwd);
  const out = capturing();
  try {
    // Never fetched: the tip's objects are not local, so no behind-count.
    await commitRepoFiles(up.cwd, { "one.txt": "one\n" });
    const tip = await git(up.cwd, ["rev-parse", "HEAD"]);
    const baseSha = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    assert.ok(
      lines(out.chunks).includes(
        `Doctor: Base ${baseSha.slice(0, 7)} is behind origin/main (tip ${tip.slice(0, 7)}). Worktrees will cut from stale history. Pull first, or pass --allow-stale-base to start from it anyway.`,
      ),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("doctor refuses the unnamed stale base too, and the escape warns there as well", async () => {
  const { up, repo } = await staleClone();
  const refused = capturing();
  const escaped = capturing();
  try {
    const baseSha = await git(repo.cwd, ["rev-parse", "HEAD"]);
    const gap =
      `Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history.`;

    const refusedExit = await doctor({
      config: config(),
      cwd: repo.cwd,
      stdout: refused.stdout,
    });
    const escapedExit = await doctor({
      config: config(),
      cwd: repo.cwd,
      allowStaleBase: true,
      stdout: escaped.stdout,
    });

    assert.equal(refusedExit, 1);
    assert.deepEqual(lines(refused.chunks), [
      "Doctor",
      `Doctor: ${gap} Pull first, or pass --allow-stale-base to start from it anyway.`,
    ]);
    assert.equal(escapedExit, 0);
    assert.deepEqual(lines(escaped.chunks), [
      "Doctor",
      `Base: ${baseSha.slice(0, 7)} on main`,
      `Warning: ${gap} Pull first`,
      "Frontier",
      "Next Ticket: 52",
    ]);
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("the preview carries the gate in Doctor's verdict and probes even though it spawns nothing", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    const baseSha = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await preview({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    const text = lines(out.chunks);
    assert.ok(
      text.includes(
        `Doctor: Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history. Pull first, or pass --allow-stale-base to start from it anyway.`,
      ),
    );
    // The Plan is still rendered whole: the base line, with the gap the Run
    // would be told about.
    assert.ok(
      text.includes(
        `Warning: Base ${baseSha.slice(0, 7)} is 2 commits behind origin/main. Worktrees will cut from stale history. Pull first`,
      ),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("the preview's equivalent command names the escape it was given", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    const exitCode = await preview({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      allowStaleBase: true,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.ok(
      lines(out.chunks).includes(
        "Run with: readyrun run --max 1 --allow-stale-base",
      ),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});

test("an unreachable probe warns, names why, and the Run starts anyway", async () => {
  const { up, repo } = await staleClone();
  const out = capturing();
  try {
    await git(repo.cwd, ["remote", "set-url", "origin", "/nonexistent/readyrun-upstream"]);

    const exitCode = await run({
      config: config(),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.match(
      out.chunks.join(""),
      /Warning: could not compare the base against origin\/main \(.*does not appear to be a git repository.*\); the Run starts on it anyway/,
    );
    assert.ok(
      lines(out.chunks).includes("Ticket 52  Ticket 52  1/1  readyrun/52"),
    );
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});
