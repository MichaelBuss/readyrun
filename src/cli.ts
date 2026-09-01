#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { doctor as doctorEntry, type DoctorOptions } from "./doctor.ts";
import { init as initEntry, parseInitAnswers, type InitAnswers, type InitOptions } from "./init.ts";
import { run as runEntry, RunCapRequiredError, type RunOptions } from "./run.ts";
import type { ReadyRunConfig } from "./config.ts";
import { isEffort, type Effort, type Permissions } from "./worker-adapter.ts";

type Writer = { write(chunk: string): unknown };

const usage = `Usage: readyrun <command>

Commands:
  init [--answers <file>]
  run --max <n> [--model <id>] [--permissions ask|unattended] [--effort low|medium|high|xhigh|max]
  doctor

A Run cannot start without a cap.
`;

const configNames = [
  "readyrun.config.ts",
  "readyrun.config.js",
  "readyrun.config.mjs",
] as const;

export class ConfigNotFoundError extends Error {
  constructor() {
    super(
      "No readyrun.config.ts, readyrun.config.js, or readyrun.config.mjs at the Consumer root",
    );
    this.name = "ConfigNotFoundError";
  }
}

export class AmbiguousConfigError extends Error {
  constructor(names: readonly string[]) {
    super(`Multiple config files at the Consumer root: ${names.join(", ")}`);
    this.name = "AmbiguousConfigError";
  }
}

export class ConfigExportError extends Error {
  constructor(name: string) {
    super(`${name} must default-export defineConfig(...)`);
    this.name = "ConfigExportError";
  }
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
  doctor?: (options: DoctorOptions) => Promise<number>;
  init?: (options: InitOptions) => Promise<number>;
  answers?: InitAnswers;
};

type RunFlags = {
  cap?: number;
  permissions?: Permissions;
  model?: string;
  effort?: Effort;
};

function parseRunFlags(args: string[]):
  | ({ ok: true } & RunFlags)
  | { ok: false; message: string } {
  let cap: number | undefined;
  let permissions: Permissions | undefined;
  let model: string | undefined;
  let effort: Effort | undefined;
  let sawMax = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max") {
      sawMax = true;
      cap = Number(args[i + 1]);
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
    }
  }
  if (sawMax && (cap === undefined || !Number.isInteger(cap) || cap < 1)) {
    return { ok: false, message: "A Run cannot start without a cap" };
  }
  return { ok: true, cap, permissions, model, effort };
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
  if (command === "run") {
    const flags = parseRunFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    runFlags = flags;
  }
  const cwd = options.cwd ?? process.cwd();
  let config: ReadyRunConfig;
  try {
    config = await (options.loadConfig ?? loadConfig)(cwd);
  } catch (error) {
    stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (runFlags !== undefined) {
    const invoke = options.run ?? runEntry;
    try {
      return await invoke({
        config,
        cap: runFlags.cap,
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
  return invoke({ config, cwd, stdout });
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

