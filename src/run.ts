import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { createTicketWorktree } from "./git.ts";
import { composeWorkerPrompt } from "./prompt.ts";
import type { Ticket } from "./ticket.ts";
import type { Permissions } from "./worker-adapter.ts";

type RunStdout = { write(chunk: string): unknown };

export type RunOptions = {
  config: ReadyRunConfig;
  cap?: number;
  cwd?: string;
  stdout?: RunStdout;
  model?: string;
  permissions?: Permissions;
};

export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
}

function warnUnusedModelsByLabel(
  stdout: RunStdout,
  modelsByLabel: Record<string, string> | undefined,
  frontier: Ticket[],
): void {
  if (modelsByLabel === undefined) {
    return;
  }
  const present = new Set(frontier.flatMap((ticket) => ticket.labels));
  for (const label of Object.keys(modelsByLabel)) {
    if (!present.has(label)) {
      stdout.write(
        `Warning: modelsByLabel key "${label}" matches no Tickets on the Frontier\n`,
      );
    }
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
      worktree = await createTicketWorktree(cwd, branch);
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
        prompt: composeWorkerPrompt(config.tracker.promptCopy(ticket), context),
      });
    } catch {
      return hardStop(stdout, "spawn", ticket.id);
    }
    if (result.exitCode !== 0) {
      return hardStop(stdout, "worker", ticket.id);
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
  }
  return 0;
}
