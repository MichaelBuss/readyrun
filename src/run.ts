import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { collectDoctorFailures, discloseBase, writeDoctorFailures, warnUnusedModelsByLabel } from "./doctor.ts";
import { startLiveness, type Liveness, type LivenessStdout } from "./liveness.ts";
import {
  branchTreeDiffersFrom,
  collectOntoRunBranch,
  createTicketWorktree,
  removeTicketWorktree,
  resolveRunBase,
  shortCommit,
  worktreeIsClean,
} from "./git.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import type { Ticket } from "./ticket.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";

type RunStdout = LivenessStdout;

export type RunOptions = {
  config: ReadyRunConfig;
  cap?: number;
  cwd?: string;
  stdout?: RunStdout;
  model?: string;
  permissions?: Permissions;
  effort?: Effort;
};

export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
}

function resolveModel(
  ticket: Ticket,
  config: ReadyRunConfig,
  runModel: string | undefined,
): string {
  const mapped = ticket.labels
    .map((label) => config.modelsByLabel?.[label])
    .find((model) => model !== undefined);
  return mapped ?? runModel ?? config.model;
}

function runBranchName(startedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    startedAt.getFullYear(),
    pad(startedAt.getMonth() + 1),
    pad(startedAt.getDate()),
    "-",
    pad(startedAt.getHours()),
    pad(startedAt.getMinutes()),
    pad(startedAt.getSeconds()),
  ].join("");
  return `readyrun/run-${stamp}`;
}

// The merge is the only commit ReadyRun writes, so its message is derived from
// the Ticket the way the Branch name is rather than authored about the code.
function mergeMessage(ticket: Ticket): string {
  return `Ticket ${ticket.id}: ${ticket.title}`;
}

type HardStopStage = "tracker" | "git" | "spawn" | "worker";

// The two clean stops (ADR 0013). Which one it was is the only fact in the
// report a Consumer cannot recover from git afterwards, and it is what says
// whether work remains on the Frontier.
type CleanStop = "frontier-empty" | "cap";

function ticketNoun(count: number): string {
  return count === 1 ? "Ticket" : "Tickets";
}

// A Run Branch is created lazily at the first merge (ADR 0028), so a Run that
// landed nothing must not name the ref it disclosed at start: git has none.
// The base is named only where there is a Branch that was cut from it.
function landingLine(
  landed: number,
  runBranch: string,
  base?: string,
): string {
  if (landed === 0) {
    return "0 Tickets landed; no Run Branch was created.";
  }
  const cutFrom = base === undefined ? "" : `, cut from ${shortCommit(base)}`;
  return `${landed} ${ticketNoun(landed)} landed on ${runBranch}${cutFrom}.`;
}

function caughtMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function hardStop(
  stdout: RunStdout,
  stage: HardStopStage,
  ticketId: string | undefined,
  detail: string | undefined,
  landed: number,
  runBranch: string,
  worktree: string | undefined,
  nextAction?: string,
): 1 {
  const ticketPrefix = ticketId === undefined ? "" : `Ticket ${ticketId} `;
  const suffix = detail === undefined ? "" : `: ${detail}`;
  const action = nextAction === undefined ? "" : `. ${nextAction}`;
  stdout.write(`Hard stop: ${ticketPrefix}failed at ${stage}${suffix}${action}\n`);
  stdout.write(`${landingLine(landed, runBranch)}\n`);
  if (worktree !== undefined) {
    stdout.write(`Worktree kept at ${worktree}\n`);
  }
  return 1;
}

// A clean stop leaves a Consumer with the question the hard-stop report already
// answers — how many Tickets landed, and whether the Run Branch ref exists —
// plus the two a hard stop has no room for: the base and why the Run stopped.
// It prescribes no push and no merge, because ReadyRun cannot decline to own
// integration and then recommend a workflow for it (ADR 0033).
function completionReport(
  stdout: RunStdout,
  reason: CleanStop,
  cap: number,
  landed: number,
  runBranch: string,
  base: string,
): 0 {
  stdout.write(
    reason === "frontier-empty"
      ? "Run complete: the Frontier is empty\n"
      : `Run complete: cap of ${cap} ${
        ticketNoun(cap)
      } reached; the Frontier may still hold work\n`,
  );
  stdout.write(`${landingLine(landed, runBranch, base)}\n`);
  return 0;
}

export async function run(options: RunOptions): Promise<number> {
  const config = defineConfig(options.config);
  const cap = options.cap ?? config.cap;
  if (cap === undefined) {
    throw new RunCapRequiredError();
  }

  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const live = startLiveness(stdout);
  try {
    return await runWithLiveness(options, config, cap, cwd, stdout, live);
  } finally {
    live.stop();
  }
}

async function runWithLiveness(
  options: RunOptions,
  config: ReadyRunConfig & { permissions: Permissions },
  cap: number,
  cwd: string,
  stdout: RunStdout,
  live: Liveness,
): Promise<number> {
  live.stage("Doctor");
  const failures = await collectDoctorFailures(
    config,
    cwd,
    options.effort ?? config.effort,
    options.permissions ?? config.permissions,
  );
  live.stop();
  if (writeDoctorFailures(stdout, failures) === 1) {
    return 1;
  }
  const runBranch = runBranchName(new Date());
  let landed = 0;
  let keptWorktree: string | undefined;
  const stop = (
    stage: HardStopStage,
    ticketId?: string,
    detail?: string,
    nextAction?: string,
  ): 1 => {
    live.stop();
    return hardStop(
      stdout,
      stage,
      ticketId,
      detail,
      landed,
      runBranch,
      keptWorktree,
      nextAction,
    );
  };
  let base;
  try {
    base = await resolveRunBase(cwd);
  } catch (error) {
    return stop(
      "git",
      undefined,
      caughtMessage(error),
    );
  }
  discloseBase(stdout, base);
  stdout.write(`Run Branch: ${runBranch}\n`);
  const complete = (reason: CleanStop): 0 => {
    live.stop();
    return completionReport(stdout, reason, cap, landed, runBranch, base.commit);
  };
  // A Ticket's Branch is cut from the Run Branch's tip, which until the first
  // Ticket lands is the base the Run resolved at start (ADR 0028).
  let runBranchTip = base.commit;
  const context = config.contextFile === undefined
    ? undefined
    : await readFile(join(cwd, config.contextFile), "utf8");
  let started = 0;
  let unusedModelsWarned = false;

  while (started < cap) {
    live.stage("Frontier");
    let frontier;
    try {
      frontier = await config.tracker.frontier();
    } catch (error) {
      return stop(
        "tracker",
        undefined,
        caughtMessage(error),
        "Check Tracker auth and network",
      );
    }
    live.stop();
    if (!unusedModelsWarned) {
      warnUnusedModelsByLabel(stdout, config.modelsByLabel, frontier);
      unusedModelsWarned = true;
    }
    const ticket = frontier[0];
    if (ticket === undefined) {
      return complete("frontier-empty");
    }

    const branch = config.tracker.branchName(ticket);
    live.stage("Worktree");
    let worktree;
    try {
      worktree = await createTicketWorktree(cwd, branch, runBranchTip);
      keptWorktree = worktree;
    } catch (error) {
      return stop(
        "git",
        ticket.id,
        caughtMessage(error),
      );
    }
    started += 1;
    live.ticket({
      id: ticket.id,
      title: ticket.title,
      branch,
      started,
      cap,
    });
    live.stage("Worker");
    let result;
    try {
      result = await config.worker.spawn({
        ticket,
        cwd: worktree,
        model: resolveModel(ticket, config, options.model),
        permissions: options.permissions ?? config.permissions,
        effort: options.effort ?? config.effort,
        prompt: composeWorkerPrompt(config.tracker.promptCopy(ticket), context),
      });
    } catch (error) {
      return stop(
        "spawn",
        ticket.id,
        caughtMessage(error),
        "Check the Worker binary and that it is logged in",
      );
    }
    if (result.exitCode !== 0) {
      return stop(
        "worker",
        ticket.id,
        `exit code ${result.exitCode}`,
        "The Ticket remains on the Frontier",
      );
    }
    // Exit 0 is not success on its own: a Worker that did nothing also exits 0
    // and also leaves a clean tree (ADR 0029).
    let clean;
    let changed;
    try {
      clean = await worktreeIsClean(worktree);
      changed = await branchTreeDiffersFrom(cwd, branch, runBranchTip);
    } catch (error) {
      return stop(
        "git",
        ticket.id,
        caughtMessage(error),
      );
    }
    if (!clean) {
      return stop(
        "worker",
        ticket.id,
        `left work uncommitted in ${worktree}`,
        "The Ticket remains on the Frontier",
      );
    }
    if (!changed) {
      return stop(
        "worker",
        ticket.id,
        `produced nothing on ${branch}`,
        "The Ticket remains on the Frontier",
      );
    }
    try {
      if (config.leaveFrontier) {
        await config.leaveFrontier(ticket);
      } else {
        await config.tracker.leaveFrontier(ticket);
      }
    } catch (error) {
      return stop(
        "tracker",
        ticket.id,
        caughtMessage(error),
        "Check the Tracker",
      );
    }
    // After the Worktree, so that a hard stop at any earlier stage leaves it on
    // disk for the Consumer to look at (ADR 0029) — and because a Branch cannot
    // be deleted while a Worktree still has it checked out.
    try {
      await removeTicketWorktree(cwd, worktree);
      keptWorktree = undefined;
    } catch (error) {
      return stop("git", ticket.id, caughtMessage(error));
    }
    try {
      runBranchTip = await collectOntoRunBranch(cwd, {
        runBranch,
        branch,
        base: base.commit,
        message: mergeMessage(ticket),
      });
      landed += 1;
    } catch (error) {
      const gitError = caughtMessage(error);
      return stop(
        "git",
        ticket.id,
        gitError === undefined
          ? "ReadyRun could not merge the Ticket's Branch into the Run Branch"
          : `ReadyRun could not merge the Ticket's Branch into the Run Branch. ${gitError}`,
      );
    }
  }
  return complete("cap");
}
