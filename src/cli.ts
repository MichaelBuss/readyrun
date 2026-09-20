#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { doctor as doctorEntry, type DoctorOptions } from "./doctor.ts";
import { parseTicketRef } from "./frontier-root.ts";
import type { FrontierRoot } from "./tracker-adapter.ts";
import { init as initEntry, parseInitAnswers, type InitAnswers, type InitOptions } from "./init.ts";
import { run as runEntry, RunCapRequiredError, type RunOptions } from "./run.ts";
import { preview as previewEntry } from "./plan.ts";
import type { ReadyRunConfig } from "./config.ts";
import { isEffort, type Effort, type Permissions } from "./worker-adapter.ts";

type Writer = { write(chunk: string): unknown };

const usage = `Usage: readyrun <command>

Commands:
  init [--answers <file>]
  run [--preview] --max <n> [--base <commit-ish>] [--ticket <id-or-url> ...] [--root <parent>] [--model <id>] [--permissions ask|unattended] [--effort low|medium|high|xhigh|max]
  doctor [--ticket <id-or-url> ...] [--root <parent>]

A Run cannot start without a cap; an explicit --ticket list defaults the cap to its length. --root runs a parent's children; the parent is never worked. run --preview prints the Plan — Doctor's verdict, the Frontier in pick order, the base, the Run Branch, the cap, the Tickets waiting — and the equivalent run command; nothing starts.
`;

const configNames = [
  "readyrun.config.ts",
  "readyrun.config.js",
  "readyrun.config.mjs",
] as const;

export class ConfigNotFoundError extends Error {
  constructor() {
    super(
      "No readyrun.config.ts, readyrun.config.js, or readyrun.config.mjs at the Consumer root. Run `readyrun init`.",
    );
    this.name = "ConfigNotFoundError";
  }
}

export class AmbiguousConfigError extends Error {
  constructor(names: readonly string[]) {
    super(
      `Multiple config files at the Consumer root: ${names.join(", ")}. Leave one file.`,
    );
    this.name = "AmbiguousConfigError";
  }
}

export class ConfigExportError extends Error {
  constructor(name: string) {
    super(
      `${name} must default-export defineConfig(...). Default-export defineConfig(...) from that file.`,
    );
    this.name = "ConfigExportError";
  }
}

function configLoadFailure(error: unknown): string {
  if (
    error instanceof ConfigNotFoundError ||
    error instanceof AmbiguousConfigError ||
    error instanceof ConfigExportError
  ) {
    return error.message;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load the ReadyRun config. Fix the config file. ${detail}`;
}

export async function loadConfig(cwd: string): Promise<ReadyRunConfig> {
  const found = configNames.filter((name) => existsSync(join(cwd, name)));
  if (found.length === 0) {
    throw new ConfigNotFoundError();
  }
  if (found.length > 1) {
    throw new AmbiguousConfigError(found);
  }
  const name = found[0];
  if (name === undefined) {
    throw new ConfigNotFoundError();
  }
  const mod: { default?: ReadyRunConfig } = await import(
    pathToFileURL(join(cwd, name)).href
  );
  if (mod.default === undefined) {
    throw new ConfigExportError(name);
  }
  return mod.default;
}

export type CliOptions = {
  argv: string[];
  cwd?: string;
  stdout?: Writer;
  loadConfig?: (cwd: string) => Promise<ReadyRunConfig>;
  run?: (options: RunOptions) => Promise<number>;
  preview?: (options: RunOptions) => Promise<number>;
  doctor?: (options: DoctorOptions) => Promise<number>;
  init?: (options: InitOptions) => Promise<number>;
  answers?: InitAnswers;
};

type RunFlags = {
  cap?: number;
  base?: string;
  permissions?: Permissions;
  model?: string;
  effort?: Effort;
  tickets: string[];
  root?: string;
  preview?: boolean;
};

// The root flags `run` and `doctor` both take (ADR 0038): a repeatable
// --ticket naming an explicit list, or one --root naming a parent — never both.
function parseRootFlags(
  args: string[],
): ({ ok: true; tickets: string[]; root?: string } | { ok: false; message: string }) {
  const tickets: string[] = [];
  let root: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ticket") {
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--ticket requires a Ticket id or URL" };
      }
      const id = parseTicketRef(value);
      if (tickets.includes(id)) {
        return { ok: false, message: `Duplicate Ticket ${id} in --ticket` };
      }
      tickets.push(id);
      i += 1;
    } else if (arg === "--root") {
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return {
          ok: false,
          message: "--root requires a parent Ticket id or URL",
        };
      }
      root = parseTicketRef(value);
      i += 1;
    }
  }
  if (tickets.length > 0 && root !== undefined) {
    return {
      ok: false,
      message:
        "--ticket names a list, --root names a parent; name one root, not both",
    };
  }
  return { ok: true, tickets, root };
}

function namedRoot(
  tickets: readonly string[],
  root: string | undefined,
): FrontierRoot | undefined {
  if (tickets.length > 0) {
    return { kind: "list", ids: tickets };
  }
  if (root !== undefined) {
    return { kind: "parent", id: root };
  }
  return undefined;
}

function parseRunFlags(args: string[]):
  | ({ ok: true } & RunFlags)
  | { ok: false; message: string } {
  const roots = parseRootFlags(args);
  if (!roots.ok) {
    return roots;
  }
  let cap: number | undefined;
  let base: string | undefined;
  let permissions: Permissions | undefined;
  let model: string | undefined;
  let effort: Effort | undefined;
  let preview = false;
  let sawMax = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max") {
      sawMax = true;
      cap = Number(args[i + 1]);
      i += 1;
    } else if (arg === "--preview") {
      preview = true;
    } else if (arg === "--base") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        return { ok: false, message: "--base requires a commit-ish" };
      }
      base = value;
      i += 1;
    } else if (arg === "--permissions") {
      const value = args[i + 1];
      if (value !== "ask" && value !== "unattended") {
        return { ok: false, message: "Permissions must be ask or unattended" };
      }
      permissions = value;
      i += 1;
    } else if (arg === "--model") {
      model = args[i + 1];
      i += 1;
    } else if (arg === "--effort") {
      const value = args[i + 1];
      if (value === undefined || !isEffort(value)) {
        return {
          ok: false,
          message: "Effort must be low, medium, high, xhigh, or max",
        };
      }
      effort = value;
      i += 1;
    } else if (arg === "--ticket" || arg === "--root") {
      i += 1;
    }
  }
  if (sawMax && (cap === undefined || !Number.isInteger(cap) || cap < 1)) {
    return { ok: false, message: "A Run cannot start without a cap" };
  }
  return {
    ok: true,
    cap,
    base,
    permissions,
    model,
    effort,
    tickets: roots.tickets,
    root: roots.root,
    preview,
  };
}

function parseInitFlags(args: string[]):
  | { ok: true; answersPath?: string }
  | { ok: false; message: string } {
  if (args.length === 0) {
    return { ok: true };
  }
  if (args[0] === "--answers") {
    const answersPath = args[1];
    if (answersPath === undefined || answersPath.length === 0) {
      return { ok: false, message: "--answers requires a file path" };
    }
    if (args.length > 2) {
      return { ok: false, message: "init accepts --answers <file>" };
    }
    return { ok: true, answersPath };
  }
  return { ok: false, message: "init accepts --answers <file>" };
}

async function answersFromFile(
  cwd: string,
  answersPath: string,
): Promise<{ ok: true; answers: InitAnswers } | { ok: false; message: string }> {
  const path = resolve(cwd, answersPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not read answers file: ${detail}` };
  }
  try {
    return parseInitAnswers(JSON.parse(raw));
  } catch {
    return { ok: false, message: "Answers file is not valid JSON" };
  }
}

export async function cli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const command = options.argv[0];
  if (command === "init") {
    const invoke = options.init ?? initEntry;
    const cwd = options.cwd ?? process.cwd();
    if (options.answers !== undefined) {
      return invoke({ cwd, answers: options.answers });
    }
    const flags = parseInitFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    if (flags.answersPath === undefined) {
      return invoke({ cwd });
    }
    const loaded = await answersFromFile(cwd, flags.answersPath);
    if (!loaded.ok) {
      stdout.write(`${loaded.message}\n`);
      return 1;
    }
    return invoke({ cwd, answers: loaded.answers });
  }
  if (command !== "run" && command !== "doctor") {
    stdout.write(usage);
    return 1;
  }
  let runFlags: RunFlags | undefined;
  let root: FrontierRoot | undefined;
  if (command === "run") {
    const flags = parseRunFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    runFlags = flags;
    root = namedRoot(flags.tickets, flags.root);
  } else {
    const flags = parseRootFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    root = namedRoot(flags.tickets, flags.root);
  }
  const cwd = options.cwd ?? process.cwd();
  let config: ReadyRunConfig;
  try {
    config = await (options.loadConfig ?? loadConfig)(cwd);
  } catch (error) {
    stdout.write(`${configLoadFailure(error)}\n`);
    return 1;
  }
  if (runFlags !== undefined) {
    const invoke = runFlags.preview
      ? options.preview ?? previewEntry
      : options.run ?? runEntry;
    try {
      return await invoke({
        config,
        cap: runFlags.cap,
        base: runFlags.base,
        root,
        cwd,
        stdout,
        permissions: runFlags.permissions,
        model: runFlags.model,
        effort: runFlags.effort,
      });
    } catch (error) {
      if (error instanceof RunCapRequiredError) {
        stdout.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }
  const invoke = options.doctor ?? doctorEntry;
  return invoke({ config, root, cwd, stdout });
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

if (isCliEntry()) {
  process.exitCode = await cli({ argv: process.argv.slice(2) });
}

