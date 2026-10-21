import { defineConfig, type ReadyRunConfig } from "./config.ts";
import {
  collectDoctorFailures,
  discloseBase,
  resolveRunSettings,
  writeDoctorFailures,
} from "./doctor.ts";
import { resolveRunBase, type RunBase, runBranchName } from "./git.ts";
import type { Liveness, LivenessStdout } from "./liveness.ts";
import { markerGaps, writeMarkerGaps, type MarkerGap } from "./merge-marker.ts";
import type { Ticket } from "./ticket.ts";
import type { FrontierRoot } from "./tracker-adapter.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";

/**
 * What a Run assembler hands the Plan's computation: the Consumer's config,
 * the cap, an optional base, the Root naming this Run's Frontier, and the
 * Run-named model, Effort, and Permissions. The flag surface `readyrun run`
 * parses maps one-to-one onto these. Owned here so the Plan is typed against
 * its own input and not the Run's option shape.
 */
export type PlanInput = {
  /** The Consumer's config, as `defineConfig` built it. */
  config: ReadyRunConfig;
  /** The cap: the most Tickets this Run may start. Required, one way or another. */
  cap?: number;
  /**
   * The commit-ish every Worktree is cut from, and what the Run Branch
   * collects onto. Defaults to the Consumer's checkout; naming the previous
   * Run Branch is how a capped Run is continued (ADR 0034). There is no config
   * key for it, because a permanently overridden base is nobody's workflow.
   */
  base?: string;
  /**
   * The Frontier's root for this Run (ADR 0038): a parent whose children
   * become the Frontier, or an explicit list that bypasses the Consumer
   * selector. A root named here replaces any config-level root, as --max and
   * --model do.
   */
  root?: FrontierRoot;
  /** The Consumer root the Run works from. Defaults to the process's. */
  cwd?: string;
  /** Where the Run's lines are written. Defaults to process stdout. */
  stdout?: LivenessStdout;
  /** The model for this Run; overrides the config default, not the label map. */
  model?: string;
  /** The Permissions for this Run; overrides the config default. */
  permissions?: Permissions;
  /** The Effort for this Run; must be in the Adapter's declared vocabulary. */
  effort?: Effort;
  /**
   * The escape from the one base gate (ADR 0046): a stale base nobody named
   * refuses the Run in Doctor's verdict, and this downgrades the refusal to
   * the warning a base named by `--base` gets. It does not skip the probe.
   */
  allowStaleBase?: boolean;
};

/**
 * A Run cannot start without a cap (there is no unlimited Run). The
 * rule lives here because the Plan resolves the cap and says where it came
 * from; `run` re-exports the class so existing import paths hold.
 */
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
  options: Pick<PlanInput, "cap" | "root">,
  config: ReadyRunConfig,
): { cap: number; source: CapSource } {
  if (options.cap !== undefined) {
    return { cap: options.cap, source: "--max" };
  }
  if (config.cap !== undefined) {
    return { cap: config.cap, source: "config cap" };
  }
  if (options.root?.kind === "list") {
    return {
      cap: options.root.ids.length,
      source: "the --ticket list's length",
    };
  }
  throw new RunCapRequiredError();
}

// The Run Branch is named when the Plan is computed, the way the Branch of a
// Ticket is named when it is picked; the Run collects onto the name the Plan
// stamped. The naming rule lives in git.ts beside the HEAD trap that matches
// the namespace it names into.
export { runBranchName };

/**
 * The Tickets waiting off the Frontier with what blocks each (ADR 0039) come
 * from the Tracker Adapter's waiting surface. An Adapter that does not answer
 * it refuses; the Plan renders the refusal rather than an empty answer that
 * would read as "nothing waits".
 */
export type PlanWaiting =
  | { kind: "answered"; tickets: Ticket[] }
  | { kind: "refused"; message: string };

/**
 * Everything a Run resolves before its first side effect (ADR 0039): Doctor's
 * verdict, the Frontier in stable pick order, the resolved base, the Run
 * Branch it collects onto, the resolved cap and where it came from, the
 * Tickets waiting off the Frontier, and the resolved Effort, Permissions, and
 * model the Workers spawn under. Doctor is the single authority on validity;
 * this computation derives none of its rules. The preview skips the
 * cwd-fidelity probe (ADR 0037) — proving cwd fidelity is the Run's, at start.
 */
export type Plan = {
  doctorFailures: string[];
  frontier: Ticket[];
  waiting: PlanWaiting;
  base: RunBase;
  runBranch: string;
  cap: number;
  capSource: CapSource;
  root?: FrontierRoot;
  /**
   * The Frontier Tickets whose left-the-Frontier blockers' merge markers the
   * base does not contain (ADR 0050) — computed once with the Plan, rendered
   * by Run start, the preview, and Doctor, and never a gate. Empty is the
   * good case and the common one; the walk only runs when a Frontier Ticket
   * carries left-the-Frontier blockers at all.
   */
  markerGaps: MarkerGap[];
  command: string;
  /** The Effort and Permissions this Run's Workers spawn under. */
  settings: { effort?: Effort; permissions: Permissions };
  /** The Run-named model override; absent reads the config and the label map. */
  model?: string;
};

/**
 * The two reads the Plan's computation can fail on name where they failed,
 * so the Run's report says the same stage it always said: the Tracker read
 * failed at the tracker, the base failed at git.
 */
export type PlanResolutionStage = "tracker" | "git";

export class PlanResolutionError extends Error {
  readonly stage: PlanResolutionStage;
  /** Doctor's verdict, when the refusal was already known (ADR 0039). */
  readonly doctorFailures: string[];

  constructor(
    stage: PlanResolutionStage,
    message: string,
    doctorFailures: string[] = [],
  ) {
    super(message);
    this.name = "PlanResolutionError";
    this.stage = stage;
    this.doctorFailures = doctorFailures;
  }
}

/**
 * Resolve the Plan: Doctor's verdict, the Frontier, the waiting Tickets, the
 * base, the Run Branch, the cap and its source, the Workers' settings, and
 * the equivalent command. Read-only end to end — it creates nothing and
 * spawns no Worker. The liveness sink is the Run's: the reads it stages are
 * the reads the loop used to stage, now that the Run consumes this Plan.
 */
export async function computePlan(
  options: PlanInput,
  live?: Pick<Liveness, "stage" | "stop">,
): Promise<Plan> {
  const config = defineConfig(options.config);
  const { cap, source } = resolveCap(options, config);
  const cwd = options.cwd ?? process.cwd();
  const root = options.root;
  live?.stage("Doctor");
  // The base is resolved before the verdict, not after: the freshness gate is
  // one of Doctor's rules (ADR 0046), so the probe rides base resolution once
  // and the verdict reads what it resolved. A base read that fails is held
  // until after the verdict, which it carries — the Run renders Doctor's
  // refusal rather than the read's stage, the way it always refused before
  // the Plan carried it.
  let base: RunBase | undefined;
  let baseError: unknown;
  try {
    base = await resolveRunBase(cwd, options.base);
  } catch (error) {
    baseError = error;
  }
  const verdict = await collectDoctorFailures({
    config,
    cwd,
    root,
    overrides: options,
    probe: false,
    base,
    allowStaleBase: options.allowStaleBase,
  });
  if (base === undefined) {
    throw new PlanResolutionError(
      "git",
      baseError instanceof Error ? baseError.message : String(baseError),
      verdict.failures,
    );
  }
  // A refused Plan is still computed whole — the preview renders its full
  // shape even on failure (ADR 0039) — but the Run that consumes it renders
  // the refusal and stops, so the read it will not act on takes no stage
  // line.
  if (verdict.failures.length === 0) {
    live?.stage("Frontier");
  }
  // The same read Doctor's check made when a Root is named; unrooted, this is
  // the one read. A Tracker that cannot be reached is a failure the preview
  // reports, not an empty Plan.
  let frontier;
  if (verdict.frontier !== undefined) {
    frontier = verdict.frontier;
  } else {
    try {
      frontier = await config.tracker.frontier(root);
    } catch (error) {
      throw new PlanResolutionError(
        "tracker",
        error instanceof Error ? error.message : String(error),
        verdict.failures,
      );
    }
  }
  let waiting: PlanWaiting;
  try {
    waiting = { kind: "answered", tickets: await config.tracker.waiting(root) };
  } catch (error) {
    waiting = {
      kind: "refused",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // The marker disclosure rides the Plan's one computation (ADR 0050): the
  // Frontier's left-the-Frontier blockers against the resolved base's
  // first-parent history. Best-effort on both ends — an Adapter that answers
  // no left blockers and a history git cannot walk both leave it empty — and
  // computed for a refused Plan too, which the preview renders whole.
  const gaps = await markerGaps(cwd, base.commit, frontier);
  return {
    doctorFailures: verdict.failures,
    frontier,
    waiting,
    base,
    runBranch: runBranchName(new Date()),
    cap,
    capSource: source,
    root,
    markerGaps: gaps,
    command: equivalentRunCommand({
      cap,
      base: options.base,
      allowStaleBase: options.allowStaleBase,
      root,
      model: options.model,
      permissions: options.permissions,
      effort: options.effort,
    }),
    settings: resolveRunSettings(config, options),
    model: options.model,
  };
}

// The exact equivalent `readyrun run …` command, in the usage line's flag
// order. The base is named as the Consumer typed it, never as the commit it
// resolved to: the command must mean the same thing when it is typed again.
export function equivalentRunCommand(
  plan: {
    cap: number;
    base?: string;
    allowStaleBase?: boolean;
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
  if (plan.allowStaleBase === true) {
    parts.push("--allow-stale-base");
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

/**
 * Render the Plan read-only, under whatever header the surface names. The
 * always-on rendering — Run-start and Doctor disclosure — says the same words
 * about the base; this adds the Frontier in pick order, the cap and its
 * source, the waiting Tickets, and closes with the exact equivalent command,
 * so the flag surface is learned by reading rather than by failing a Run.
 * `run --preview` renders it under the preview's header; the Launcher renders
 * the same Plan under its own before the Run it confirmed starts.
 */
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
      `Frontier: ${plan.frontier.length} ${
        ticketNoun(plan.frontier.length)
      } in pick order\n`,
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
      `Waiting: ${tickets.length} ${
        ticketNoun(tickets.length)
      } off the Frontier\n`,
    );
    for (const ticket of tickets) {
      stdout.write(`${waitingLine(ticket)}\n`);
    }
  }
  await discloseBase(stdout, plan.base, cwd);
  // The marker disclosure renders wherever the Plan renders, in the same
  // words Run start and Doctor say (ADR 0050) — after the base, which is
  // what the gaps are measured against.
  writeMarkerGaps(stdout, plan.markerGaps);
  stdout.write(
    `Run Branch: ${plan.runBranch} (named when the Plan is computed)\n`,
  );
  stdout.write(
    `Cap: ${plan.cap} ${ticketNoun(plan.cap)} from ${plan.capSource}\n`,
  );
  stdout.write("Cwd-fidelity probe: not run; the Run proves it at start\n");
  stdout.write(`Run with: ${plan.command}\n`);
}

/**
 * `run --preview`: the Plan rendered and nothing else — it exits before any
 * mutation and spawns no Worker. A Doctor verdict with failures still renders
 * the whole Plan (the prose names the fix and the Plan carries the command,
 * ADR 0039); the exit code says the Run it previews would be refused.
 *
 * @returns 0 when the previewed Run would start, 1 when Doctor would refuse it.
 */
export async function preview(options: PlanInput): Promise<number> {
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
