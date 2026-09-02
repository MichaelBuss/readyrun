import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class DefaultBranchError extends Error {
  constructor(branch: string) {
    super(`ReadyRun refuses to start a Worker on the default branch (${branch})`);
    this.name = "DefaultBranchError";
  }
}

export class WorktreeExistsError extends Error {
  constructor(branch: string, worktreePath: string) {
    super(
      `ReadyRun already has a Worktree for branch ${branch} at ${worktreePath}`,
    );
    this.name = "WorktreeExistsError";
  }
}

export class WorktreeInstallError extends Error {
  constructor(command: string, output: string) {
    const detail = output.trim();
    super(
      detail === ""
        ? `ReadyRun failed to install Worktree dependencies with ${command}`
        : `ReadyRun failed to install Worktree dependencies with ${command}:\n${detail}`,
    );
    this.name = "WorktreeInstallError";
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
  return stripRepoDecorations(value).toLowerCase();
}

function stripRepoDecorations(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function parseOwnerRepo(url: string): string | undefined {
  const trimmed = stripRepoDecorations(url);
  const ssh = trimmed.match(/^git@[^:]+:(.+\/.+)$/);
  if (ssh?.[1] !== undefined) {
    return ssh[1];
  }
  const path = trimmed.match(/[:/]([^/]+\/[^/]+)$/);
  return path?.[1];
}

async function branchTip(
  cwd: string,
  branch: string,
): Promise<string | undefined> {
  try {
    return await git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function headCommit(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "HEAD"]);
}

export async function worktreeIsClean(worktreePath: string): Promise<boolean> {
  return await git(worktreePath, ["status", "--porcelain"]) === "";
}

// Read the Branch ref, not the Worktree's HEAD: a Worker that committed
// somewhere else left the Ticket's Branch as empty as one that did nothing.
export async function branchHasCommitsSince(
  cwd: string,
  branch: string,
  base: string,
): Promise<boolean> {
  const count = await git(cwd, [
    "rev-list",
    "--count",
    `${base}..refs/heads/${branch}`,
  ]);
  return count !== "0";
}

export async function createTicketWorktree(
  cwd: string,
  branch: string,
  base: string,
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

  if (
    await branchTip(cwd, branch) !== undefined || await pathExists(worktreePath)
  ) {
    throw new WorktreeExistsError(branch, worktreePath);
  }

  await mkdir(join(cwd, ".readyrun", "worktrees"), { recursive: true });
  // A Worktree kept on failure and then deleted by hand rather than with
  // `git worktree remove` leaves admin state that fails the next add.
  await git(cwd, ["worktree", "prune"]);
  await exec("git", [
    "-C",
    cwd,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    base,
  ]);
  await installWorktreeDependencies(worktreePath);
  return worktreePath;
}

export type CollectOntoRunBranchOptions = {
  runBranch: string;
  branch: string;
  base: string;
  message: string;
};

// Merges with plumbing rather than `git merge`, because the Run Branch never
// needs a working tree of its own and the Consumer's checkout is theirs to
// stand on: a Run collects Tickets without moving anyone (ADR 0028).
export async function collectOntoRunBranch(
  cwd: string,
  options: CollectOntoRunBranchOptions,
): Promise<string> {
  const runRef = `refs/heads/${options.runBranch}`;
  const existing = await branchTip(cwd, options.runBranch);
  const tip = existing ?? options.base;
  const collected = await git(cwd, [
    "rev-parse",
    "--verify",
    `refs/heads/${options.branch}`,
  ]);
  const tree = await git(cwd, ["merge-tree", "--write-tree", tip, collected]);
  // Two parents and no fast-forward: one Ticket is one entry in the Run
  // Branch's first-parent history, with the Worker's own commits underneath.
  const merge = await git(cwd, [
    "commit-tree",
    tree,
    "-p",
    tip,
    "-p",
    collected,
    "-m",
    options.message,
  ]);
  // The merge that lands is what writes the ref — an empty old value where the
  // Run Branch does not exist yet, so a Run that never lands a Ticket, or whose
  // first merge fails, leaves no Run Branch behind.
  await git(cwd, ["update-ref", runRef, merge, existing ?? ""]);
  // `--force` because the Branch is merged into the Run Branch, which is not
  // the branch the Consumer's checkout is on, so git cannot see that itself.
  await git(cwd, ["branch", "--delete", "--force", options.branch]);
  return merge;
}

// Plain `remove`, not `--force`: a Worktree still holding work is a hard stop
// the Run has already refused to reach, so failing loudly here is right.
export async function removeTicketWorktree(
  cwd: string,
  worktreePath: string,
): Promise<void> {
  await git(cwd, ["worktree", "remove", worktreePath]);
}

async function installWorktreeDependencies(worktreePath: string): Promise<void> {
  const command = await detectInstallCommand(worktreePath);
  if (command === undefined) {
    return;
  }
  const invocation = [command.bin, ...command.args].join(" ");
  try {
    await exec(command.bin, command.args, { cwd: worktreePath, encoding: "utf8" });
  } catch (error) {
    throw new WorktreeInstallError(invocation, execErrorOutput(error));
  }
}

function execErrorOutput(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const stdout = "stdout" in error && typeof error.stdout === "string"
      ? error.stdout
      : "";
    const stderr = "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
    const combined = `${stdout}${stderr}`.trim();
    if (combined !== "") {
      return combined;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

type PackageManager = "pnpm" | "npm" | "yarn";

const installCommands: Record<PackageManager, { bin: string; args: string[] }> = {
  pnpm: { bin: "pnpm", args: ["install", "--frozen-lockfile"] },
  npm: { bin: "npm", args: ["ci"] },
  yarn: { bin: "yarn", args: ["--frozen-lockfile"] },
};

async function detectInstallCommand(
  worktreePath: string,
): Promise<{ bin: string; args: string[] } | undefined> {
  const packageJsonPath = join(worktreePath, "package.json");
  if (!await pathExists(packageJsonPath)) {
    return undefined;
  }
  const fromLockfile = await lockfilePackageManager(worktreePath);
  if (fromLockfile === undefined) {
    return undefined;
  }
  const fromField = await packageManagerField(packageJsonPath);
  return installCommands[fromField ?? fromLockfile];
}

async function packageManagerField(
  packageJsonPath: string,
): Promise<PackageManager | undefined> {
  try {
    const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof manifest.packageManager !== "string") {
      return undefined;
    }
    const name = manifest.packageManager.split("@")[0];
    if (name === "pnpm" || name === "npm" || name === "yarn") {
      return name;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function lockfilePackageManager(
  worktreePath: string,
): Promise<PackageManager | undefined> {
  if (await pathExists(join(worktreePath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(worktreePath, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(join(worktreePath, "package-lock.json"))) {
    return "npm";
  }
  return undefined;
}
