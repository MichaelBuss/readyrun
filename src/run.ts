import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { discloseBase, doctorCheck, warnUnusedModelsByLabel } from "./doctor.ts";
import {
  branchTreeDiffersFrom,
  collectOntoRunBranch,
  createTicketWorktree,
  removeTicketWorktree,
  resolveRunBase,
  worktreeIsClean,
} from "./git.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import type { Ticket } from "./ticket.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";

type RunStdout = { write(chunk: string): unknown };

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
  if (landed === 0) {
    stdout.write("0 Tickets landed; no Run Branch was created.\n");
  } else {
    const noun = landed === 1 ? "Ticket" : "Tickets";
    stdout.write(`${landed} ${noun} landed on ${runBranch}.\n`);
  }
  if (worktree !== undefined) {
    stdout.write(`Worktree kept at ${worktree}\n`);
  }
  return 1;
}

export async function run(options: RunOptions): Promise<number> {
  const config = defineConfig(options.config);
  const cap = options.cap ?? config.cap;
  if (cap === undefined) {
    throw new RunCapRequiredError();
  }

  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  if (
    await doctorCheck(
      config,
      cwd,
      stdout,
      options.effort ?? config.effort,
      options.permissions ?? config.permissions,
    ) === 1
  ) {
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
  ): 1 =>
    hardStop(
      stdout,
      stage,
      ticketId,
      detail,
      landed,
      runBranch,
      keptWorktree,
      nextAction,
    );
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
  // A Ticket's Branch is cut from the Run Branch's tip, which until the first
  // Ticket lands is the base the Run resolved at start (ADR 0028).
  let runBranchTip = base.commit;
  const context = config.contextFile === undefined
    ? undefined
    : await readFile(join(cwd, config.contextFile), "utf8");
  let started = 0;
  let unusedModelsWarned = false;

  while (started < cap) {
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
    if (!unusedModelsWarned) {
      warnUnusedModelsByLabel(stdout, config.modelsByLabel, frontier);
      unusedModelsWarned = true;
    }
    const ticket = frontier[0];
    if (ticket === undefined) {
      return 0;
    }

    const branch = config.tracker.branchName(ticket);
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
    stdout.write(`Ticket ${ticket.id}  ${started}/${cap}  ${branch}\n`);
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
  return 0;
}
