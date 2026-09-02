import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SpawnRequest } from "../src/worker-adapter.ts";

const exec = promisify(execFile);
const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

export type ThrowawayRepo = {
  cwd: string;
  cleanup(): Promise<void>;
};

export async function throwawayRepo(options: {
  defaultBranch?: string;
  commits?: boolean;
} = {}): Promise<ThrowawayRepo> {
  const defaultBranch = options.defaultBranch ?? "main";
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, "repo-"));
  await exec("git", ["-c", "init.templateDir=", "init", "-b", defaultBranch], {
    cwd,
  });
  await exec("git", ["config", "user.email", "readyrun@example.com"], {
    cwd,
  });
  await exec("git", ["config", "user.name", "ReadyRun"], { cwd });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd });
  await exec("git", ["config", "init.defaultBranch", defaultBranch], { cwd });
  if (options.commits ?? true) {
    await writeFile(join(cwd, "README"), "throwaway\n");
    await exec("git", ["add", "README"], { cwd });
    await exec("git", ["commit", "-m", "init"], { cwd });
  }
  return {
    cwd,
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export async function onDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runBranches(cwd: string): Promise<string[]> {
  const refs = await git(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/readyrun/run-*",
  ]);
  return refs.split("\n").filter(Boolean);
}

// A Run has exactly one Run Branch, so a test that asks for it means that one.
export async function runBranch(cwd: string): Promise<string> {
  const branches = await runBranches(cwd);
  const only = branches[0];
  if (only === undefined || branches.length > 1) {
    throw new Error(
      `expected one Run Branch, found ${branches.join(", ") || "none"}`,
    );
  }
  return only;
}

// The subjects of the Run Branch's first-parent history: one per Ticket the
// Run landed, most recent first.
export async function runBranchMerges(
  cwd: string,
  base: string,
): Promise<string[]> {
  const log = await git(cwd, [
    "log",
    "--first-parent",
    "--format=%s",
    `${base}..${await runBranch(cwd)}`,
  ]);
  return log.split("\n").filter(Boolean);
}

export async function commitRepoFiles(
  cwd: string,
  files: Record<string, string>,
  message = "consumer manifest",
): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(cwd, name, ".."), { recursive: true });
    await writeFile(join(cwd, name), contents);
  }
  await exec("git", ["add", "--", ...Object.keys(files)], { cwd });
  await exec("git", ["commit", "-m", message], { cwd });
}

// A Worker doing what the prompt tells it: committing its work on its Branch.
export async function commitWorkerWork(request: SpawnRequest): Promise<void> {
  await commitRepoFiles(
    request.cwd,
    { [`ticket-${request.ticket.id}.txt`]: "the Worker's work\n" },
    `Ticket ${request.ticket.id}`,
  );
}

export async function commitNpmConsumer(cwd: string): Promise<void> {
  await mkdir(join(cwd, "vendor", "local-dep"), { recursive: true });
  await writeFile(
    join(cwd, "vendor", "local-dep", "package.json"),
    `${JSON.stringify({ name: "local-dep", version: "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({
      name: "fixture-consumer",
      version: "1.0.0",
      dependencies: { "local-dep": "file:vendor/local-dep" },
    }, null, 2)}\n`,
  );
  await exec("npm", ["install", "--package-lock-only"], { cwd });
  await exec("git", [
    "add",
    "package.json",
    "package-lock.json",
    "vendor",
  ], { cwd });
  await exec("git", ["commit", "-m", "consumer manifest"], { cwd });
}

export async function commitMismatchedNpmLockfile(cwd: string): Promise<void> {
  await commitRepoFiles(cwd, {
    "package.json": `${JSON.stringify({
      name: "fixture-consumer",
      version: "1.0.0",
      dependencies: { "left-pad": "1.3.0" },
    }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({
      name: "fixture-consumer",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "fixture-consumer", version: "1.0.0" },
      },
    }, null, 2)}\n`,
  });
}

