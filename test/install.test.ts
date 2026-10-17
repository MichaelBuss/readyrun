import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTicketWorktree, headCommit } from "../src/git.ts";
import {
  installWorktreeDependencies,
  unignoredInstallOutput,
  WorktreeInstallError,
} from "../src/install.ts";
import {
  commitMismatchedNpmLockfile,
  commitNpmConsumer,
  commitRepoFiles,
  throwawayRepo,
} from "./throwaway-repo.ts";

// A Worktree arrives install-free — dependency install is not its creation's
// to do — so what a test installs afterwards is the install seam's doing.
async function installFreeWorktree(cwd: string): Promise<string> {
  return await createTicketWorktree(cwd, "readyrun/52", await headCommit(cwd));
}

async function withInstallShim(
  cwd: string,
  bin: string,
  fn: () => Promise<void>,
): Promise<string> {
  const binDir = join(cwd, ".bins");
  const record = join(cwd, "install-args");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, bin),
    `#!/bin/sh
printf '%s\\n' "$*" > "$READYRUN_INSTALL_RECORD"
mkdir -p node_modules
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${previousPath === undefined ? "" : `:${previousPath}`}`;
  process.env.READYRUN_INSTALL_RECORD = record;
  try {
    await fn();
    return (await readFile(record, "utf8")).trim();
  } finally {
    process.env.PATH = previousPath;
    delete process.env.READYRUN_INSTALL_RECORD;
  }
}

test("installWorktreeDependencies installs deps from a Consumer lockfile", async () => {
  const repo = await throwawayRepo();
  try {
    await commitNpmConsumer(repo.cwd);
    const worktreePath = await installFreeWorktree(repo.cwd);
    await installWorktreeDependencies(worktreePath);
    await access(join(worktreePath, "node_modules"));
  } finally {
    await repo.cleanup();
  }
});

test("installWorktreeDependencies runs pnpm install --frozen-lockfile when packageManager names pnpm", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, {
      "package.json": `${JSON.stringify({
        name: "fixture-consumer",
        version: "1.0.0",
        packageManager: "pnpm@9.15.0",
      }, null, 2)}\n`,
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const worktreePath = await installFreeWorktree(repo.cwd);
    const args = await withInstallShim(repo.cwd, "pnpm", async () => {
      await installWorktreeDependencies(worktreePath);
    });
    await access(join(worktreePath, "node_modules"));
    assert.equal(args, "install --frozen-lockfile");
  } finally {
    await repo.cleanup();
  }
});

test("installWorktreeDependencies runs yarn --frozen-lockfile when the Consumer has a yarn.lock", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, {
      "package.json": `${JSON.stringify({
        name: "fixture-consumer",
        version: "1.0.0",
      }, null, 2)}\n`,
      "yarn.lock": "# yarn lockfile v1\n",
    });
    const worktreePath = await installFreeWorktree(repo.cwd);
    const args = await withInstallShim(repo.cwd, "yarn", async () => {
      await installWorktreeDependencies(worktreePath);
    });
    await access(join(worktreePath, "node_modules"));
    assert.equal(args, "--frozen-lockfile");
  } finally {
    await repo.cleanup();
  }
});

test("installWorktreeDependencies skips install when the Consumer has no lockfile", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, {
      "package.json": `${JSON.stringify({
        name: "fixture-consumer",
        version: "1.0.0",
      }, null, 2)}\n`,
    });
    const worktreePath = await installFreeWorktree(repo.cwd);
    await installWorktreeDependencies(worktreePath);
    await assert.rejects(access(join(worktreePath, "node_modules")), {
      code: "ENOENT",
    });
  } finally {
    await repo.cleanup();
  }
});

test("installWorktreeDependencies fails with the install command's output when install fails", async () => {
  const repo = await throwawayRepo();
  try {
    await commitMismatchedNpmLockfile(repo.cwd);
    const worktreePath = await installFreeWorktree(repo.cwd);
    await assert.rejects(
      installWorktreeDependencies(worktreePath),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeInstallError);
        assert.match(error.message, /npm ci/);
        assert.match(error.message, /in sync|lock file/i);
        return true;
      },
    );
  } finally {
    await repo.cleanup();
  }
});

test("unignoredInstallOutput is node_modules when the Consumer would not ignore or track it", async () => {
  const repo = await throwawayRepo();
  try {
    await commitNpmConsumer(repo.cwd);
    assert.equal(await unignoredInstallOutput(repo.cwd), "node_modules");
  } finally {
    await repo.cleanup();
  }
});

test("unignoredInstallOutput is undefined once .gitignore covers the install output", async () => {
  const repo = await throwawayRepo();
  try {
    await commitNpmConsumer(repo.cwd);
    await writeFile(join(repo.cwd, ".gitignore"), "node_modules/\n");
    assert.equal(await unignoredInstallOutput(repo.cwd), undefined);
  } finally {
    await repo.cleanup();
  }
});

test("unignoredInstallOutput is undefined when the Consumer has no lockfile to install from", async () => {
  const repo = await throwawayRepo();
  try {
    assert.equal(await unignoredInstallOutput(repo.cwd), undefined);
  } finally {
    await repo.cleanup();
  }
});
