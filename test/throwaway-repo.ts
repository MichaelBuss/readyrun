import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

export type ThrowawayRepo = {
  cwd: string;
  cleanup(): Promise<void>;
};

export async function throwawayRepo(options: {
  defaultBranch?: string;
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
  await writeFile(join(cwd, "README"), "throwaway\n");
  await exec("git", ["add", "README"], { cwd });
  await exec("git", ["commit", "-m", "init"], { cwd });
  return {
    cwd,
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export async function commitRepoFiles(
  cwd: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(cwd, name, ".."), { recursive: true });
    await writeFile(join(cwd, name), contents);
  }
  await exec("git", ["add", "--", ...Object.keys(files)], { cwd });
  await exec("git", ["commit", "-m", "consumer manifest"], { cwd });
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

