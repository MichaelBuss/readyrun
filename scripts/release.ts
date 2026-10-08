#!/usr/bin/env node
// The release script: the one place a version ships. The changesets GitHub
// Action runs it on every push to main that has no pending changesets — i.e.
// right after the Version Packages PR merges — but any other main merge lands
// here too, so everything is idempotent: a version already on a registry is
// skipped, the tag and GitHub Release are only created when missing. npm
// publishes via trusted publishing (OIDC, --provenance); JSR publishes via
// OIDC as it always has. When npm publishing is not configured yet, the
// failure is instructive: exact human setup steps, never a silent skip, never
// an opaque error.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type JsrMeta = {
  latest?: string;
  versions?: Record<string, unknown>;
};

export type ReleasePlan = { npm: boolean; jsr: boolean };

export function publishedVersions(meta: JsrMeta): string[] {
  const versions = new Set(Object.keys(meta.versions ?? {}));
  if (meta.latest !== undefined && meta.latest !== "") {
    versions.add(meta.latest);
  }
  return [...versions];
}

export function planRelease(input: {
  version: string;
  npmVersions: readonly string[];
  jsrVersions: readonly string[];
}): ReleasePlan {
  return {
    npm: !input.npmVersions.includes(input.version),
    jsr: !input.jsrVersions.includes(input.version),
  };
}

export function isNpmSetupError(stderr: string): boolean {
  return /E404|E403|E409|ENEEDAUTH|402 Payment Required|403 Forbidden|404 Not Found|not have permission/.test(
    stderr,
  );
}

export function npmSetupInstructions(name: string, version: string): string {
  return `npm refused to publish ${name}@${version} — trusted publishing is not configured yet. A human needs to:

1. Claim the \`@readyrun\` scope on npmjs.com (create the org if it does not exist).
2. Publish the package once (or open its settings) and configure **Trusted Publishing** for it: registry.npmjs.org, GitHub, repository \`MichaelBuss/readyrun\`, workflow \`.github/workflows/publish.yml\`.
3. Re-run the failed release workflow — it skips anything already published and finishes the rest.`;
}

type ShResult = { status: number; stdout: string; stderr: string };

function sh(command: string, args: readonly string[]): ShResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  }
}

async function npmVersions(name: string): Promise<string[] | undefined> {
  const result = sh("npm", ["view", name, "versions", "--json"]);
  if (result.status !== 0) {
    if (isNpmSetupError(result.stderr)) {
      return [];
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout) as string[] | string;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return undefined;
  }
}

async function jsrVersions(name: string): Promise<string[] | undefined> {
  try {
    const response = await fetch(`https://jsr.io/${name}/meta.json`);
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      return undefined;
    }
    return publishedVersions((await response.json()) as JsrMeta);
  } catch {
    return undefined;
  }
}

async function appendSummary(text: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path === undefined) {
    return;
  }
  await appendFile(path, text);
}

async function commentOnMergedPr(instructions: string): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (repo === undefined || sha === undefined) {
    return;
  }
  const pr = sh("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[0].number"]);
  const number = pr.stdout.trim();
  if (pr.status !== 0 || number === "") {
    return;
  }
  sh("gh", ["pr", "comment", number, "--repo", repo, "--body", instructions]);
}

function ensureTag(version: string): boolean {
  const tag = `v${version}`;
  if (sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status === 0) {
    return true;
  }
  if (sh("git", ["tag", tag]).status !== 0) {
    return false;
  }
  return sh("git", ["push", "origin", tag]).status === 0;
}

async function ensureGithubRelease(version: string): Promise<boolean> {
  const tag = `v${version}`;
  if (sh("gh", ["release", "view", tag]).status === 0) {
    return true;
  }
  const withNotes = sh("gh", [
    "release",
    "create",
    tag,
    "--generate-notes",
    "--title",
    tag,
  ]);
  if (withNotes.status === 0) {
    return true;
  }
  return sh("gh", ["release", "create", tag]).status === 0;
}

export async function releaseCli(argv: readonly string[]): Promise<number> {
  void argv;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const { name, version } = pkg;

  const onNpm = await npmVersions(name);
  if (onNpm === undefined) {
    process.stderr.write(`Cannot determine what npm already has for ${name}; not risking a double publish.\n`);
    return 1;
  }
  const onJsr = await jsrVersions(name);
  if (onJsr === undefined) {
    process.stderr.write(`Cannot fetch jsr.io metadata for ${name}; not risking a double publish.\n`);
    return 1;
  }

  const plan = planRelease({ version, npmVersions: onNpm, jsrVersions: onJsr });
  if (!plan.npm && !plan.jsr) {
    process.stdout.write(`${name}@${version} is already on npm and JSR; ensuring tag and release exist.\n`);
    const tagged = ensureTag(version);
    const released = await ensureGithubRelease(version);
    process.stdout.write(tagged && released ? "Nothing to publish; tag and release are in place.\n" : "Tag or release could not be ensured.\n");
    return tagged && released ? 0 : 1;
  }

  if (plan.npm) {
    process.stdout.write(`Publishing ${name}@${version} to npm with provenance.\n`);
    const publish = sh("npm", ["publish", "--provenance", "--access", "public"]);
    if (publish.status !== 0) {
      process.stderr.write(publish.stderr);
      if (isNpmSetupError(publish.stderr)) {
        const instructions = npmSetupInstructions(name, version);
        process.stdout.write(`\n${instructions}\n`);
        await appendSummary(`## npm publish needs human setup\n\n${instructions}\n`);
        await commentOnMergedPr(instructions);
      }
      return 1;
    }
  }

  if (plan.jsr) {
    process.stdout.write(`Publishing ${name}@${version} to JSR.\n`);
    const publish = sh("npx", ["jsr", "publish"]);
    if (publish.status !== 0) {
      process.stderr.write(publish.stderr);
      return 1;
    }
  }

  const tagged = ensureTag(version);
  if (!tagged) {
    process.stderr.write(`Published, but the v${version} tag could not be created or pushed.\n`);
    return 1;
  }
  const released = await ensureGithubRelease(version);
  if (!released) {
    process.stderr.write(`Published and tagged, but the GitHub Release for v${version} could not be created.\n`);
    return 1;
  }
  process.stdout.write(`Released ${name}@${version}: npm, JSR, tag v${version}, GitHub Release.\n`);
  return 0;
}

if (isCliEntry()) {
  process.exitCode = await releaseCli(process.argv.slice(2));
}
