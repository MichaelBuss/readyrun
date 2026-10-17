import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Installing a fresh Worktree's dependencies failed; the fix is outside the Run. */
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

// npm / pnpm / yarn frozen install all write here. A Consumer that neither
// tracks nor ignores it makes every Worktree look dirty after ReadyRun's own
// install, which the dirty-Worktree hard stop then blames on the Worker.
const installOutput = "node_modules";

// Dependency install is a step of its own, visible to its caller: Worktree
// creation hands back a checkout whose dependencies are not installed yet,
// and whoever hands that Worktree to a Worker installs them first.
export async function installWorktreeDependencies(
  worktreePath: string,
): Promise<void> {
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

export async function unignoredInstallOutput(
  cwd: string,
): Promise<string | undefined> {
  if (await detectInstallCommand(cwd) === undefined) {
    return undefined;
  }
  // Trailing slash: `node_modules/` in .gitignore only matches a directory, and
  // check-ignore cannot see that a missing path is one unless we say so.
  if (
    await pathIsIgnored(cwd, `${installOutput}/`) ||
    await pathIsTracked(cwd, installOutput)
  ) {
    return undefined;
  }
  return installOutput;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pathIsIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await exec("git", ["-C", cwd, "check-ignore", "-q", "--", path]);
    return true;
  } catch (error) {
    if (execExitCode(error) === 1) {
      return false;
    }
    throw error;
  }
}

async function pathIsTracked(cwd: string, path: string): Promise<boolean> {
  return await exec("git", ["-C", cwd, "ls-files", "--", path], {
    encoding: "utf8",
  }).then(({ stdout }) => stdout.trim() !== "");
}

function execExitCode(error: unknown): number | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }
  return undefined;
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
