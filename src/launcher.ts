import {
  cancel,
  confirm,
  intro,
  outro,
  select,
  text,
  type SelectOptions,
} from "@clack/prompts";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import {
  ConfigNotFoundError,
  configLoadFailure,
  loadConfig,
} from "./consumer-config.ts";
import {
  headContainsCommit,
  headRunBranchTrap,
  listRunBranches,
  resolveRunBase,
  type ListedRunBranch,
} from "./git.ts";
import { init as initEntry, type InitOptions } from "./init.ts";
import { computePlan, renderPlan, type Plan } from "./plan.ts";
import { run as runEntry, type RunOptions } from "./run.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";

// The Launcher's only terminal surface. The flow below talks to this shape,
// so the whole assembly is testable with scripted answers; the default
// implementation forwards to Clack, the dependency Init already uses
// (ADR 0040).
export type LauncherIO = {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  text(options: {
    message: string;
    initialValue?: string;
    validate?(value: string | undefined): string | undefined;
  }): Promise<string | symbol>;
  select<T extends string>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T | symbol>;
  confirm(options: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean | symbol>;
};

const clackLauncherIO: LauncherIO = {
  intro: (message) => {
    intro(message);
  },
  outro: (message) => {
    outro(message);
  },
  cancel: (message) => {
    cancel(message);
  },
  text: async (options) => await text(options),
  select: async <T extends string>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }) => await select<T>(options as SelectOptions<T>),
  confirm: async (options) =>
    await confirm({
      message: options.message,
      initialValue: options.initialValue,
    }),
};

// The cap suggestion is the Plan's unblocked Frontier size (ADR 0040),
// floored at an explicit list's length, because a list whose cap is below
// its own length is a slice nobody asked for. At least 1: a Run cannot start
// with a cap of zero.
export function capSuggestion(
  frontierSize: number,
  root: RunOptions["root"],
): number {
  const floor = root?.kind === "list" ? root.ids.length : 0;
  return Math.max(frontierSize, floor, 1);
}

// Every answer the Launcher collects is flag-expressible (ADR 0040); the cap
// is the one that must parse before the Run can price it.
export function capAnswer(
  value: string | undefined,
): { ok: true; cap: number } | { ok: false; message: string } {
  const cap = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isInteger(cap) || cap < 1) {
    return { ok: false, message: "Cap must be a whole number of at least 1" };
  }
  return { ok: true, cap };
}

// The HEAD-state logic the Run Branch base picker answers (ADR 0040): parked
// on a Run Branch the default branch does not contain, steer to --base from
// the default branch; standing on a checkout that lacks the newest Run
// Branch's work, offer the picker; already containing it, a fresh Run with
// nothing to continue. Only unmerged Run Branches are ever offered — a merged
// one holds nothing left to review — and the picker lists Run Branches,
// never Worktrees (ADR 0029).
export type HeadBaseState =
  | { kind: "fresh" }
  | {
    kind: "steer";
    branch: string;
    defaultBranch: string;
    unmerged: ListedRunBranch[];
  }
  | { kind: "pick"; unmerged: ListedRunBranch[] };

export async function headBaseState(cwd: string): Promise<HeadBaseState> {
  const branches = await listRunBranches(cwd);
  const unmerged = branches.filter((branch) => !branch.mergedIntoDefault);
  const base = await resolveRunBase(cwd);
  const trap = await headRunBranchTrap(cwd, base);
  if (trap !== undefined) {
    return {
      kind: "steer",
      branch: trap.branch,
      defaultBranch: trap.defaultBranch,
      unmerged,
    };
  }
  const newest = unmerged[0];
  if (newest === undefined || await headContainsCommit(cwd, newest.tip)) {
    return { kind: "fresh" };
  }
  return { kind: "pick", unmerged };
}

// An answer kept at its config default carries no flag: the flags-only
// invocation of the same answers omits it, so the Plan's equivalent command
// shows exactly what differs.
const keptDefault = Symbol("kept-default");

type Collected<T> = { value: T } | typeof keptDefault;

export type LauncherOptions = {
  cwd?: string;
  stdout?: { write(chunk: string): unknown };
  loadConfig?: (cwd: string) => Promise<ReadyRunConfig>;
  run?: (options: RunOptions) => Promise<number>;
  init?: (options: InitOptions) => Promise<number>;
  io?: LauncherIO;
};

// The plan the Launcher renders before its confirm — the same Plan
// `run --preview` renders, under a header that says a Run will start.
const launcherPlanHeader = "Plan for this Run\n";

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function launcher(options: LauncherOptions = {}): Promise<number> {
  const io = options.io ?? clackLauncherIO;
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  const load = options.loadConfig ?? loadConfig;
  let config: ReadyRunConfig;
  let greeted = false;
  try {
    config = await load(cwd);
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError)) {
      stdout.write(`${configLoadFailure(error)}\n`);
      return 1;
    }
    greeted = true;
    io.intro("ReadyRun");
    const offered = await io.confirm({
      message: "No ReadyRun config found. Run init?",
      initialValue: true,
    });
    if (typeof offered === "symbol" || !offered) {
      io.cancel("Init cancelled.");
      return 1;
    }
    const exit = await (options.init ?? initEntry)({ cwd });
    if (exit !== 0) {
      return exit;
    }
    try {
      config = await load(cwd);
    } catch (error) {
      io.cancel("Init did not leave a usable config.");
      stdout.write(`${configLoadFailure(error)}\n`);
      return 1;
    }
  }
  if (!greeted) {
    io.intro("ReadyRun");
  }
  const resolved = defineConfig(config);
  let frontierSize: number;
  try {
    frontierSize = (await resolved.tracker.frontier(undefined)).length;
  } catch (error) {
    io.cancel(`Could not read the Frontier: ${caughtMessage(error)}`);
    return 1;
  }
  const cap = await collectCap(io, frontierSize);
  if (cap === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const permissions = await collectPermissions(io, resolved);
  if (permissions === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const model = await collectModel(io, resolved);
  if (model === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const effort = resolved.worker.effortFlag === undefined
    ? keptDefault
    : await collectEffort(io, resolved);
  if (effort === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  let state: HeadBaseState;
  try {
    state = await headBaseState(cwd);
  } catch (error) {
    // A checkout git cannot answer for — no commit yet, or no repository —
    // has no HEAD state to read and nothing to assemble a Run on.
    io.cancel(`Could not read the checkout's HEAD state: ${caughtMessage(error)}`);
    return 1;
  }
  const base = await collectBase(io, state);
  if (base === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const runOptions: RunOptions = {
    config: resolved,
    cap: cap.value,
    base: base.base,
    root: undefined,
    cwd,
    stdout,
    permissions: permissions === keptDefault ? undefined : permissions.value,
    model: model === keptDefault ? undefined : model.value,
    effort: effort === keptDefault ? undefined : effort.value,
  };
  let plan: Plan;
  try {
    plan = await computePlan(runOptions);
  } catch (error) {
    io.cancel(`Could not resolve the Plan: ${caughtMessage(error)}`);
    return 1;
  }
  await renderPlan(stdout, plan, cwd, launcherPlanHeader);
  const start = await io.confirm({
    message: "Start this Run?",
    initialValue: true,
  });
  if (typeof start === "symbol") {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  if (!start) {
    io.outro("Run not started.");
    return 1;
  }
  // On confirm the Launcher exits its own UI; the Run's ADR 0035 renderer
  // owns the terminal from here (ADR 0040). Nothing above created anything:
  // every read was Plan work, so a Ctrl-C leaves no half-created Run.
  io.outro("Starting the Run");
  return await (options.run ?? runEntry)(runOptions);
}

// The Effort option value that means "leave it to the config and the
// Worker": never an Effort itself, so a kept default and a picked effort
// cannot collide.
export const defaultEffort = "__default__";

async function collectCap(
  io: LauncherIO,
  frontierSize: number,
): Promise<{ value: number } | undefined> {
  const answer = await io.text({
    message: "Cap — the most Tickets this Run may start",
    initialValue: String(capSuggestion(frontierSize, undefined)),
    validate: (value) => {
      const parsed = capAnswer(value);
      return parsed.ok ? undefined : parsed.message;
    },
  });
  if (typeof answer === "symbol") {
    return undefined;
  }
  const parsed = capAnswer(answer);
  return parsed.ok ? { value: parsed.cap } : undefined;
}

async function collectPermissions(
  io: LauncherIO,
  config: ReadyRunConfig,
): Promise<Collected<Permissions> | undefined> {
  const picked = await io.select<Permissions>({
    message: "Permissions",
    initialValue: config.permissions,
    options: [
      { value: "ask", label: "Ask", hint: "the Worker asks before acting" },
      {
        value: "unattended",
        label: "Unattended",
        hint: "the Worker acts without asking",
      },
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  return picked === config.permissions ? keptDefault : { value: picked };
}

async function collectModel(
  io: LauncherIO,
  config: ReadyRunConfig,
): Promise<Collected<string> | undefined> {
  const answer = await io.text({
    message: "Model",
    initialValue: config.model,
    validate: (value) =>
      value === undefined || value.trim() === "" ? "Required" : undefined,
  });
  if (typeof answer === "symbol") {
    return undefined;
  }
  const trimmed = answer.trim();
  return trimmed === config.model ? keptDefault : { value: trimmed };
}

async function collectEffort(
  io: LauncherIO,
  config: ReadyRunConfig,
): Promise<Collected<Effort> | undefined> {
  const picked = await io.select<Effort | typeof defaultEffort>({
    message: "Effort",
    initialValue: config.effort ?? defaultEffort,
    options: [
      {
        value: defaultEffort,
        label: config.effort === undefined
          ? "Worker default"
          : `Config default (${config.effort})`,
      },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" },
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  if (picked === defaultEffort || picked === config.effort) {
    return keptDefault;
  }
  return { value: picked };
}

const freshRun = "__fresh__";

type BaseAnswer = { base: string | undefined };

async function collectBase(
  io: LauncherIO,
  state: HeadBaseState,
): Promise<BaseAnswer | undefined> {
  if (state.kind === "fresh") {
    return { base: undefined };
  }
  if (state.kind === "steer") {
    const picked = await io.select<string>({
      message: `HEAD is the Run Branch ${state.branch}, which the default branch (${state.defaultBranch}) does not contain — start this Run from the default branch`,
      initialValue: state.defaultBranch,
      options: [
        {
          value: state.defaultBranch,
          label: state.defaultBranch,
          hint: "start from the default branch",
        },
        ...state.unmerged.map((branch) => ({
          value: branch.name,
          label: branch.name,
          hint: "continue this Run Branch",
        })),
      ],
    });
    if (typeof picked === "symbol") {
      return undefined;
    }
    return { base: picked };
  }
  const picked = await io.select<string | typeof freshRun>({
    message: "Base for this Run",
    initialValue: state.unmerged[0]?.name,
    options: [
      ...state.unmerged.map((branch) => ({
        value: branch.name,
        label: branch.name,
        hint: "continue this Run Branch",
      })),
      { value: freshRun, label: "Fresh Run from HEAD", hint: "no --base" },
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  return { base: picked === freshRun ? undefined : picked };
}
