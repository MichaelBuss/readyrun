import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { doctorCheck, warnUnusedModelsByLabel } from "./doctor.ts";
import {
  branchHasCommitsSince,
  createTicketWorktree,
  headCommit,
  removeTicketWorktree,
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

type HardStopStage = "tracker" | "git" | "spawn" | "worker";

function hardStop(
  stdout: RunStdout,
  stage: HardStopStage,
  ticketId?: string,
  detail?: string,
): 1 {
  const ticketPrefix = ticketId === undefined ? "" : `Ticket ${ticketId} `;
  const suffix = detail === undefined ? "" : `: ${detail}`;
  stdout.write(`Hard stop: ${ticketPrefix}failed at ${stage}${suffix}\n`);
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
  let base;
  try {
    base = await headCommit(cwd);
  } catch (error) {
    return hardStop(
      stdout,
      "git",
      undefined,
      error instanceof Error ? error.message : undefined,
    );
  }
  const context = config.contextFile === undefined
    ? undefined
    : await readFile(join(cwd, config.contextFile), "utf8");
  let started = 0;
  let unusedModelsWarned = false;

  while (started < cap) {
    let frontier;
    try {
      frontier = await config.tracker.frontier();
    } catch {
      return hardStop(stdout, "tracker");
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
      worktree = await createTicketWorktree(cwd, branch, base);
    } catch (error) {
      return hardStop(
        stdout,
        "git",
        ticket.id,
        error instanceof Error ? error.message : undefined,
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
    } catch {
      return hardStop(stdout, "spawn", ticket.id);
    }
    if (result.exitCode !== 0) {
      return hardStop(
        stdout,
        "worker",
        ticket.id,
        `exit code ${result.exitCode}`,
      );
    }
    // Exit 0 is not success on its own: a Worker that did nothing also exits 0
    // and also leaves a clean tree (ADR 0027).
    let clean;
    let committed;
    try {
      clean = await worktreeIsClean(worktree);
      committed = await branchHasCommitsSince(cwd, branch, base);
    } catch (error) {
      return hardStop(
        stdout,
        "git",
        ticket.id,
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!clean) {
      return hardStop(
        stdout,
        "worker",
        ticket.id,
        `left work uncommitted in ${worktree}`,
      );
    }
    if (!committed) {
      return hardStop(
        stdout,
        "worker",
        ticket.id,
        `committed nothing on ${branch}`,
      );
    }
    try {
      if (config.leaveFrontier) {
        await config.leaveFrontier(ticket);
      } else {
        await config.tracker.leaveFrontier(ticket);
      }
    } catch {
      return hardStop(stdout, "tracker", ticket.id);
    }
    // Last, so that a hard stop at any earlier stage leaves the Worktree on
    // disk for the Consumer to look at (ADR 0027).
    try {
      await removeTicketWorktree(cwd, worktree);
    } catch (error) {
      return hardStop(
        stdout,
        "git",
        ticket.id,
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  return 0;
}
