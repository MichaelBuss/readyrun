import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { createTicketWorktree } from "./git.ts";

export type RunOptions = {
  config: ReadyRunConfig;
  cap?: number;
  cwd?: string;
  stdout?: { write(chunk: string): unknown };
};

export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
}

export async function run(options: RunOptions): Promise<void> {
  const config = defineConfig(options.config);
  const cap = options.cap ?? config.cap;
  if (cap === undefined) {
    throw new RunCapRequiredError();
  }

  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  let started = 0;

  while (started < cap) {
    const frontier = await config.tracker.frontier();
    const ticket = frontier[0];
    if (ticket === undefined) {
      return;
    }

    const branch = config.tracker.branchName(ticket);
    const worktree = await createTicketWorktree(cwd, branch);
    started += 1;
    stdout.write(`Ticket ${ticket.id}  ${started}/${cap}  ${branch}\n`);
    const result = await config.worker.spawn({ ticket, cwd: worktree });
    if (result.exitCode !== 0) {
      return;
    }
    if (config.leaveFrontier) {
      await config.leaveFrontier(ticket);
    } else {
      await config.tracker.leaveFrontier(ticket);
    }
  }
}
