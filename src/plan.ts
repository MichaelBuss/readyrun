import { defineConfig, type ReadyRunConfig } from "./config.ts";
import {
  collectDoctorFailures,
  discloseBase,
  writeDoctorFailures,
} from "./doctor.ts";
import {
  resolveRunBase,
  runBranchName,
  type RunBase,
} from "./git.ts";
import type { Ticket } from "./ticket.ts";
import type { FrontierRoot } from "./tracker-adapter.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";
import type { RunOptions } from "./run.ts";

// A Run cannot start without a cap (CONTEXT: there is no unlimited Run). The
// rule lives here because the Plan resolves the cap and says where it came
// from; `run` re-exports the class so existing import paths hold.
export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
}

// The cap resolves --max, then config, then an explicit list's length
// (ADR 0038), so a single-Ticket invocation is a Run with cap 1. Where it
// came from is part of the Plan (ADR 0039).
export type CapSource = "--max" | "config cap" | "the --ticket list's length";

export function resolveCap(
  options: Pick<RunOptions, "cap" | "root">,
  config: ReadyRunConfig,
): { cap: number; source: CapSource } {
  if (options.cap !== undefined) {
    return { cap: options.cap, source: "--max" };
  }
  if (config.cap !== undefined) {
    return { cap: config.cap, source: "config cap" };
  }
  if (options.root?.kind === "list") {
    return { cap: options.root.ids.length, source: "the --ticket list's length" };
  }
  throw new RunCapRequiredError();
}

// The Run Branch is derived from the moment the Run starts, the way the
// Branch of a Ticket is; a Plan names the one its Run would collect onto.
// The naming rule lives in git.ts beside the HEAD trap that matches the
// namespace it names into.
export { runBranchName };

// The Tickets waiting off the Frontier with what blocks each (ADR 0039) come
// from the Tracker Adapter's waiting surface. An Adapter that does not answer
// it refuses; the Plan renders the refusal rather than an empty answer that
// would read as "nothing waits".
export type PlanWaiting =
  | { kind: "answered"; tickets: Ticket[] }
  | { kind: "refused"; message: string };

// Everything a Run resolves before its first side effect (ADR 0039): Doctor's
// verdict, the Frontier in stable pick order, the resolved base, the Run
// Branch it would collect onto, the resolved cap and where it came from, and
// the Tickets waiting off the Frontier. Doctor is the single authority on
// validity; this computation derives none of its rules. The preview skips the
// cwd-fidelity probe (ADR 0037) — proving cwd fidelity is the Run's, at start.
export type Plan = {
  doctorFailures: string[];
  frontier: Ticket[];
  waiting: PlanWaiting;
  base?: RunBase;
  runBranch: string;
  cap: number;
  capSource: CapSource;
  root?: FrontierRoot;
  command: string;
};

export async function computePlan(options: RunOptions): Promise<Plan> {
  const config = defineConfig(options.config);
  const { cap, source } = resolveCap(options, config);
  const cwd = options.cwd ?? process.cwd();
  const root = options.root;
  const doctorFailures = await collectDoctorFailures(
    config,
    cwd,
    options.effort ?? config.effort,
    options.permissions ?? config.permissions,
    root,
    { probe: false },
  );
  const base = await resolveRunBase(cwd, options.base);
  // The same frontier call the Run's first iteration makes; a Tracker that
  // cannot be reached is a failure the preview reports, not an empty Plan.
  const frontier = await config.tracker.frontier(root);
  let waiting: PlanWaiting;
  try {
    waiting = { kind: "answered", tickets: await config.tracker.waiting(root) };
  } catch (error) {
    waiting = {
      kind: "refused",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    doctorFailures,
    frontier,
    waiting,
    base,
    runBranch: runBranchName(new Date()),
    cap,
    capSource: source,
    root,
    command: equivalentRunCommand({
      cap,
      base: options.base,
      root,
      model: options.model,
      permissions: options.permissions,
      effort: options.effort,
    }),
  };
}

// The exact equivalent `readyrun run …` command, in the usage line's flag
// order. The base is named as the Consumer typed it, never as the commit it
// resolved to: the command must mean the same thing when it is typed again.
export function equivalentRunCommand(
  plan: {
    cap: number;
    base?: string;
    root?: FrontierRoot;
    model?: string;
    permissions?: Permissions;
    effort?: Effort;
  },
): string {
  const parts = ["readyrun", "run", "--max", String(plan.cap)];
  if (plan.base !== undefined) {
    parts.push("--base", plan.base);
  }
  if (plan.root?.kind === "list") {
    parts.push("--ticket", ...plan.root.ids);
  } else if (plan.root?.kind === "parent") {
    parts.push("--root", plan.root.id);
  }
  if (plan.model !== undefined) {
    parts.push("--model", plan.model);
  }
  if (plan.permissions !== undefined) {
    parts.push("--permissions", plan.permissions);
  }
  if (plan.effort !== undefined) {
    parts.push("--effort", plan.effort);
  }
  return parts.join(" ");
}

function ticketNoun(count: number): string {
  return count === 1 ? "Ticket" : "Tickets";
}

function waitingLine(ticket: Ticket): string {
  const blockers = ticket.blockedBy.join(", ") || "an unknown blocker";
  return `  ${ticket.id} waits on ${blockers}`;
}

// The Plan's rendering (ADR 0039), read-only end to end, under whatever
// header the surface names. The always-on rendering — Run-start and Doctor
// disclosure — says the same words about the base; this adds the Frontier in
// pick order, the cap and its source, the waiting Tickets, and closes with
// the exact equivalent command, so the flag surface is learned by reading
// rather than by failing a Run. `run --preview` renders it under the
// preview's header; the Launcher renders the same Plan under its own before
// the Run it confirmed starts.
export async function renderPlan(
  stdout: { write(chunk: string): unknown },
  plan: Plan,
  cwd: string,
  header = "Run preview: nothing starts; this Plan is read-only\n",
): Promise<void> {
  stdout.write(header);
  if (plan.doctorFailures.length === 0) {
    stdout.write("Doctor: pass\n");
  } else {
    writeDoctorFailures(stdout, plan.doctorFailures);
  }
  if (plan.frontier.length === 0) {
    stdout.write("Frontier: empty\n");
  } else {
    stdout.write(
      `Frontier: ${plan.frontier.length} ${ticketNoun(plan.frontier.length)} in pick order\n`,
    );
    plan.frontier.forEach((ticket, index) => {
      stdout.write(`  ${index + 1}. ${ticket.id} ${ticket.title}\n`);
    });
  }
  if (plan.waiting.kind === "refused") {
    stdout.write(`Waiting: ${plan.waiting.message}\n`);
  } else if (plan.waiting.tickets.length === 0) {
    stdout.write("Waiting: none\n");
  } else {
    const tickets = plan.waiting.tickets;
    stdout.write(
      `Waiting: ${tickets.length} ${ticketNoun(tickets.length)} off the Frontier\n`,
    );
    for (const ticket of tickets) {
      stdout.write(`${waitingLine(ticket)}\n`);
    }
  }
  if (plan.base !== undefined) {
    await discloseBase(stdout, plan.base, cwd);
  }
  stdout.write(
    `Run Branch: ${plan.runBranch} (named when the Run starts)\n`,
  );
  stdout.write(`Cap: ${plan.cap} ${ticketNoun(plan.cap)} from ${plan.capSource}\n`);
  stdout.write("Cwd-fidelity probe: not run; the Run proves it at start\n");
  stdout.write(`Run with: ${plan.command}\n`);
}

// `run --preview`: the Plan rendered and nothing else — it exits before any
// mutation and spawns no Worker. A Doctor verdict with failures still renders
// the whole Plan (the prose names the fix and the Plan carries the command,
// ADR 0039); the exit code says the Run it previews would be refused.
export async function preview(options: RunOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  let plan: Plan;
  try {
    plan = await computePlan(options);
  } catch (error) {
    if (error instanceof RunCapRequiredError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    stdout.write(`Preview failed: ${detail}\n`);
    return 1;
  }
  await renderPlan(stdout, plan, cwd);
  return plan.doctorFailures.length === 0 ? 0 : 1;
}
