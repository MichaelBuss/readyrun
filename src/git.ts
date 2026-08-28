import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class DefaultBranchError extends Error {
  constructor(branch: string) {
    super(`ReadyRun refuses to start a Worker on the default branch (${branch})`);
    this.name = "DefaultBranchError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function defaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    try {
      return await git(cwd, ["config", "--local", "--get", "init.defaultBranch"]);
    } catch {
      const heads = await git(cwd, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ]);
      const names = heads.split("\n").filter(Boolean);
      if (names.includes("main")) {
        return "main";
      }
      if (names.includes("master")) {
        return "master";
      }
      return names[0] ?? "main";
    }
  }
}

export async function originRepository(cwd: string): Promise<string | undefined> {
  try {
    return parseOwnerRepo(await git(cwd, ["remote", "get-url", "origin"]));
  } catch {
    return undefined;
  }
}

export function normalizeRepository(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

function parseOwnerRepo(url: string): string | undefined {
  const trimmed = normalizeRepository(url);
  const ssh = trimmed.match(/^git@[^:]+:(.+\/.+)$/);
  if (ssh?.[1] !== undefined) {
    return ssh[1];
  }
  const path = trimmed.match(/[:/]([^/]+\/[^/]+)$/);
  return path?.[1];
}

export async function createTicketWorktree(
  cwd: string,
  branch: string,
): Promise<string> {
  const currentDefault = await defaultBranch(cwd);
  if (branch === currentDefault) {
    throw new DefaultBranchError(branch);
  }

  const worktreePath = join(
    cwd,
    ".readyrun",
    "worktrees",
    branch.replaceAll("/", "-"),
  );
  await mkdir(join(cwd, ".readyrun", "worktrees"), { recursive: true });
  await exec("git", ["-C", cwd, "worktree", "add", "-b", branch, worktreePath]);
  return worktreePath;
}
