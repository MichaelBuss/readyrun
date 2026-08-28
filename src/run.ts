import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { createTicketWorktree } from "./git.ts";

type RunStdout = { write(chunk: string): unknown };

export type RunOptions = {
  config: ReadyRunConfig;
  cap?: number;
  cwd?: string;
  stdout?: RunStdout;
};

export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
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
  let started = 0;

  while (started < cap) {
    let frontier;
    try {
      frontier = await config.tracker.frontier();
    } catch {
      return hardStop(stdout, "tracker");
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
      result = await config.worker.spawn({ ticket, cwd: worktree });
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
