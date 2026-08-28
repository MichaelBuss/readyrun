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