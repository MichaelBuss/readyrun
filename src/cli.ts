#!/usr/bin/env node

/**
 * The `readyrun` command line: four commands plus the bare command.
 *
 * - `init [--answers <file>]` — write the Consumer's `readyrun.config.ts`
 *   stub and cover `.readyrun/` in `.gitignore`; interactive by default,
 *   scriptable with `--answers`.
 * - `run [--preview] --max <n> …` — walk the Frontier, one Worker per
 *   Ticket, collecting each Ticket's Branch onto the Run Branch.
 * - `doctor` — check config and any named Root against the Tracker without
 *   starting a Run.
 * - `deliver --mode <name> --branch <run-branch>` — publish a Run Branch's
 *   settled history per the named Delivery strategy (ADR 0048).
 * - bare `readyrun` — the Launcher on a TTY; usage off one.
 *
 * This module is the bin, not the library surface: Consumers import from the
 * package root. Entry is {@link cli}.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReadyRunConfig } from "./config.ts";
import {
  AmbiguousConfigError,
  ConfigExportError,
  ConfigNotFoundError,
  configLoadFailure,
  loadConfig,
} from "./consumer-config.ts";
import { doctor as doctorEntry, type DoctorOptions } from "./doctor.ts";
import {
  deliver as deliverEntry,
  deliverPlan,
  previewDelivery as previewDeliveryEntry,
  type DeliverInput,
} from "./deliver.ts";
import { parseTicketRef } from "./frontier-root.ts";
import { launcher as launcherEntry, type LauncherOptions } from "./launcher.ts";
import type { FrontierRoot } from "./tracker-adapter.ts";
import { init as initEntry, parseInitAnswers, type InitAnswers, type InitOptions } from "./init.ts";
import { run as runEntry, runPlan, RunCapRequiredError, type RunOptions } from "./run.ts";
import { preview as previewEntry } from "./plan.ts";
import { isEffort, type Effort, type Permissions } from "./worker-adapter.ts";

export { AmbiguousConfigError, ConfigExportError, ConfigNotFoundError, loadConfig };

type Writer = { write(chunk: string): unknown };

const usage = `Usage: readyrun <command>

Commands:
  init [--answers <file>]
  run [--preview] --max <n> [--base <commit-ish>] [--allow-stale-base] [--ticket <id-or-url> ...] [--root <parent>] [--model <id>] [--permissions ask|unattended] [--effort low|medium|high|xhigh|max]
  doctor [--ticket <id-or-url> ...] [--root <parent>] [--allow-stale-base]
  deliver --mode <name> --branch <run-branch> [--preview] [--draft] [--label <name> ...]

A Run cannot start without a cap; an explicit --ticket list defaults the cap to its length. --root runs a parent's children; the parent is never worked. A base nobody named that stands stale behind origin refuses the Run until --allow-stale-base says otherwise; a base named by --base is only warned. run --preview prints the Plan — Doctor's verdict, the Frontier in pick order, the base, the Run Branch, the cap, the Tickets waiting — and the equivalent run command; nothing starts.
deliver publishes a Run Branch's settled history (ADR 0048): --mode is a built-in (family-pr, stack, main) or a registered Delivery strategy, --branch names the Run Branch, and --draft/--label are creation options of the pull requests. deliver --preview prints the Delivery's Plan — what would be pushed, which PRs opened, on which bases — and the equivalent command; nothing is published.
`;

/**
 * How {@link cli} runs. Every field but `argv` defaults to the real
 * environment; the invoke fields are the seams tests script instead.
 */
export type CliOptions = {
  /** The command and its flags, as the process received them. */
  argv: string[];
  /** The Consumer root. Defaults to the process's working directory. */
  cwd?: string;
  /** Where command output is written. Defaults to process stdout. */
  stdout?: Writer;
  /**
   * Whether the terminal can host the Launcher (ADR 0040): a TTY on both
   * ends. Only the bare command reads it; every flag path is unchanged.
   */
  tty?: boolean;
  /** Loads the Consumer's config. Defaults to the real loader. */
  loadConfig?: (cwd: string) => Promise<ReadyRunConfig>;
  /** The `run` implementation invoked. Defaults to the real Run. */
  run?: (options: RunOptions) => Promise<number>;
  /** The `run --preview` implementation invoked. Defaults to the real preview. */
  preview?: (options: RunOptions) => Promise<number>;
  /** The `doctor` implementation invoked. Defaults to the real Doctor. */
  doctor?: (options: DoctorOptions) => Promise<number>;
  /** The `deliver` implementation invoked. Defaults to the real Delivery. */
  deliver?: (options: DeliverInput) => Promise<number>;
  /** The `deliver --preview` implementation invoked. Defaults to the real preview. */
  previewDelivery?: (options: DeliverInput) => Promise<number>;
  /** The `init` implementation invoked. Defaults to the real Init. */
  init?: (options: InitOptions) => Promise<number>;
  /** The bare command's Launcher. Defaults to the real Launcher. */
  launcher?: (options: LauncherOptions) => Promise<number>;
  /** Answers for `init`, taking the place of `--answers <file>`. */
  answers?: InitAnswers;
};

type RunFlags = {
  cap?: number;
  base?: string;
  allowStaleBase?: boolean;
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

// The one flag `doctor` takes beyond the root flags (ADR 0046): the base
// gate's escape, so Doctor can pre-flight exactly the Run the escape names.
// It takes no value, so filtering it out ahead of the root parse is safe.
function parseDoctorFlags(
  args: string[],
): { ok: true; allowStaleBase: boolean; tickets: string[]; root?: string } |
  { ok: false; message: string } {
  const escape = "--allow-stale-base";
  const allowStaleBase = args.includes(escape);
  const roots = parseRootFlags(args.filter((arg) => arg !== escape));
  if (!roots.ok) {
    return roots;
  }
  return { ok: true, allowStaleBase, tickets: roots.tickets, root: roots.root };
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
  let allowStaleBase: boolean | undefined;
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
    } else if (arg === "--allow-stale-base") {
      allowStaleBase = true;
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
    allowStaleBase,
    permissions,
    model,
    effort,
    tickets: roots.tickets,
    root: roots.root,
    preview,
  };
}

// The delivery's flags (ADR 0048): the mode and the Run Branch, both
// explicit — a delivery is never guessed — plus the pull-request creation
// options and the preview. Both required flags refuse their absence by name.
function parseDeliverFlags(
  args: string[],
): { ok: true; mode: string; branch: string; draft: boolean; labels: string[]; preview: boolean } |
  { ok: false; message: string } {
  let mode: string | undefined;
  let branch: string | undefined;
  let draft = false;
  const labels: string[] = [];
  let preview = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--mode requires a Delivery mode name" };
      }
      mode = value;
      i += 1;
    } else if (arg === "--branch") {
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--branch requires a Run Branch name" };
      }
      branch = value;
      i += 1;
    } else if (arg === "--draft") {
      draft = true;
    } else if (arg === "--label") {
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: "--label requires a label name" };
      }
      labels.push(value);
      i += 1;
    } else if (arg === "--preview") {
      preview = true;
    } else {
      return {
        ok: false,
        message:
          "deliver accepts --mode <name>, --branch <run-branch>, --draft, --label <name>, and --preview",
      };
    }
  }
  if (mode === undefined) {
    return { ok: false, message: "deliver requires --mode <name>" };
  }
  if (branch === undefined) {
    return { ok: false, message: "deliver requires --branch <run-branch>" };
  }
  return { ok: true, mode, branch, draft, labels, preview };
}

function parseInitFlags(args: string[]):
  | { ok: true; answersPath?: string }
  | { ok: false; message: string } {  if (args.length === 0) {
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

/**
 * Run one `readyrun` command and answer its exit code. Parses `argv`,
 * loads the Consumer's config for `run` and `doctor`, and dispatches:
 * `init`, `run` (or its preview), `doctor`, or — bare, on a TTY — the
 * Launcher. Off a TTY, or on an unknown command, it writes usage and
 * answers 1.
 *
 * @returns The process exit code the command answered.
 */
export async function cli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const command = options.argv[0];
  if (command === undefined) {
    const tty = options.tty ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!tty) {
      stdout.write(usage);
      return 1;
    }
    const invoke = options.launcher ?? launcherEntry;
    return invoke({
      cwd: options.cwd ?? process.cwd(),
      stdout,
      loadConfig: options.loadConfig ?? loadConfig,
      // The Launcher hands the Plan it rendered to the Run or Delivery that
      // consumes it (ADR 0039, ADR 0048); the flag path's seams have the
      // options contracts.
      run: runPlan,
      deliver: deliverPlan,
      init: options.init ?? initEntry,
    });
  }
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
  if (command === "deliver") {
    const flags = parseDeliverFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    const cwd = options.cwd ?? process.cwd();
    let config: ReadyRunConfig;
    try {
      config = await (options.loadConfig ?? loadConfig)(cwd);
    } catch (error) {
      stdout.write(`${configLoadFailure(error)}\n`);
      return 1;
    }
    const invoke = flags.preview
      ? options.previewDelivery ?? previewDeliveryEntry
      : options.deliver ?? deliverEntry;
    return invoke({
      config,
      mode: flags.mode,
      branch: flags.branch,
      cwd,
      stdout,
      draft: flags.draft || undefined,
      labels: flags.labels.length > 0 ? flags.labels : undefined,
    });
  }
  if (command !== "run" && command !== "doctor") {
    stdout.write(usage);
    return 1;
  }
  let runFlags: RunFlags | undefined;
  let root: FrontierRoot | undefined;
  let allowStaleBase: boolean | undefined;
  if (command === "run") {
    const flags = parseRunFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    runFlags = flags;
    root = namedRoot(flags.tickets, flags.root);
    allowStaleBase = flags.allowStaleBase;
  } else {
    const flags = parseDoctorFlags(options.argv.slice(1));
    if (!flags.ok) {
      stdout.write(`${flags.message}\n`);
      return 1;
    }
    root = namedRoot(flags.tickets, flags.root);
    allowStaleBase = flags.allowStaleBase;
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
        allowStaleBase,
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
  return invoke({ config, root, cwd, stdout, allowStaleBase });
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

