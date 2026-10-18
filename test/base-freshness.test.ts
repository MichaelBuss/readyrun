import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunBase } from "../src/git.ts";
import { commitRepoFiles, git, throwawayClone, throwawayRepo } from "./throwaway-repo.ts";

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

    assert.deepEqual(base.freshness, { kind: "stale", tip, behind: 2 });
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

    assert.deepEqual(base.freshness, { kind: "stale", tip, behind: undefined });
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

    assert.deepEqual(base.freshness, { kind: "stale", tip, behind: 1 });
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
      reason: "origin has no branch named main",
    });
  } finally {
    await up.cleanup();
    await repo.cleanup();
  }
});
