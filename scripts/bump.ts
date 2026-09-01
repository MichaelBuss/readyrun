#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const bumpUsage = `Usage: npm run bump -- [patch | minor | major | <x.y.z>] [--baseline <x.y.z>]

Updates package.json, package-lock.json, and jsr.json together.
--baseline bumps from whichever is higher: the local version, or the
given one (e.g. origin/main's, in case this branch is behind).
Does not commit or tag. Default is patch.
`;

const bumpKinds = ["major", "minor", "patch"] as const;
export type BumpKind = (typeof bumpKinds)[number];

export class BumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BumpError";
  }
}

function isBumpKind(spec: string): spec is BumpKind {
  return (bumpKinds as readonly string[]).includes(spec);
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new BumpError(`Not a semver x.y.z: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function higherVersion(a: string, b: string): string {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i]! > pb[i]! ? a : b;
    }
  }
  return a;
}

export function parseBumpSpec(argv: readonly string[]): string {
  if (argv.length === 0) {
    return "patch";
  }
  if (argv.length !== 1) {
    throw new BumpError(bumpUsage.trimEnd());
  }
  const [arg] = argv;
  if (arg === undefined) {
    throw new BumpError(bumpUsage.trimEnd());
  }
  if (arg === "-h" || arg === "--help") {
    throw new BumpError(bumpUsage.trimEnd());
  }
  const spec = arg.startsWith("--") ? arg.slice(2) : arg;
  if (isBumpKind(spec)) {
    return spec;
  }
  parseSemver(spec);
  return spec;
}

export function nextVersion(current: string, spec = "patch"): string {
  if (isBumpKind(spec)) {
    const [major, minor, patch] = parseSemver(current);
    if (spec === "major") {
      return `${major + 1}.0.0`;
    }
    if (spec === "minor") {
      return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
  }
  parseSemver(spec);
  if (spec === current) {
    throw new BumpError(`Already at ${current}`);
  }
  return spec;
}

type Versioned = { version: string };

type Lockfile = Versioned & {
  packages?: { ""?: Versioned };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function bump(
  root: string,
  spec = "patch",
  baseline?: string,
): Promise<{ from: string; to: string }> {
  const pkgPath = join(root, "package.json");
  const jsrPath = join(root, "jsr.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = await readJson<Versioned>(pkgPath);
  const jsr = await readJson<Versioned>(jsrPath);
  if (pkg.version !== jsr.version) {
    throw new BumpError(
      `package.json (${pkg.version}) and jsr.json (${jsr.version}) disagree; fix that first.`,
    );
  }
  const from = pkg.version;
  // A branch's own version can be stale relative to origin/main (e.g. another
  // PR bumped and merged after this branch was cut), so bump from whichever
  // is higher rather than trusting the checked-out files blindly.
  const base = baseline === undefined ? from : higherVersion(from, baseline);
  const to = nextVersion(base, spec);
  pkg.version = to;
  jsr.version = to;
  await writeJson(pkgPath, pkg);
  await writeJson(jsrPath, jsr);
  if (existsSync(lockPath)) {
    const lock = await readJson<Lockfile>(lockPath);
    lock.version = to;
    if (lock.packages?.[""] !== undefined) {
      lock.packages[""].version = to;
    }
    await writeJson(lockPath, lock);
  }
  return { from, to };
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

export function extractBaseline(argv: readonly string[]): { rest: string[]; baseline?: string } {
  const index = argv.indexOf("--baseline");
  if (index === -1) {
    return { rest: [...argv] };
  }
  const baseline = argv[index + 1];
  if (baseline === undefined) {
    throw new BumpError("--baseline requires a version argument");
  }
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 2)], baseline };
}

export async function bumpCli(argv: readonly string[]): Promise<number> {
  const [arg] = argv;
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(bumpUsage);
    return 0;
  }
  try {
    const { rest, baseline } = extractBaseline(argv);
    const spec = parseBumpSpec(rest);
    const { from, to } = await bump(
      join(dirname(fileURLToPath(import.meta.url)), ".."),
      spec,
      baseline,
    );
    process.stdout.write(`${from} → ${to}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (isCliEntry()) {
  process.exitCode = await bumpCli(process.argv.slice(2));
}
