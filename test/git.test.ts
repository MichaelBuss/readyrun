import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createTicketWorktree, originRepository, WorktreeExistsError, WorktreeInstallError } from "../src/git.ts";
import { commitMismatchedNpmLockfile, commitNpmConsumer, commitRepoFiles, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);

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

test("createTicketWorktree installs Worktree deps from a Consumer lockfile before returning", async () => {
  const repo = await throwawayRepo();
  try {
    await commitNpmConsumer(repo.cwd);
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52");
    await access(join(worktreePath, "node_modules"));
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree runs pnpm install --frozen-lockfile when packageManager names pnpm", async () => {
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
    let worktreePath = "";
    const args = await withInstallShim(repo.cwd, "pnpm", async () => {
      worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52");
    });
    await access(join(worktreePath, "node_modules"));
    assert.equal(args, "install --frozen-lockfile");
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree runs yarn --frozen-lockfile when the Consumer has a yarn.lock", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, {
      "package.json": `${JSON.stringify({
        name: "fixture-consumer",
        version: "1.0.0",
      }, null, 2)}\n`,
      "yarn.lock": "# yarn lockfile v1\n",
    });
    let worktreePath = "";
    const args = await withInstallShim(repo.cwd, "yarn", async () => {
      worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52");
    });
    await access(join(worktreePath, "node_modules"));
    assert.equal(args, "--frozen-lockfile");
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree skips install when the Consumer has no lockfile", async () => {
  const repo = await throwawayRepo();
  try {
    await commitRepoFiles(repo.cwd, {
      "package.json": `${JSON.stringify({
        name: "fixture-consumer",
        version: "1.0.0",
      }, null, 2)}\n`,
    });
    const worktreePath = await createTicketWorktree(repo.cwd, "readyrun/52");
    await assert.rejects(access(join(worktreePath, "node_modules")), {
      code: "ENOENT",
    });
  } finally {
    await repo.cleanup();
  }
});

test("createTicketWorktree fails with the install command's output when install fails", async () => {
  const repo = await throwawayRepo();
  try {
    await commitMismatchedNpmLockfile(repo.cwd);
    await assert.rejects(
      createTicketWorktree(repo.cwd, "readyrun/52"),
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
