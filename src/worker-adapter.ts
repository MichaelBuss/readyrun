import type { Ticket } from "./ticket.ts";

const brand = Symbol("WorkerAdapter");

export type Permissions = "ask" | "unattended";

export type SpawnRequest = {
  ticket: Ticket;
  cwd: string;
  model: string;
  permissions: Permissions;
  prompt: string;
};

export type WorkerAdapter = {
  readonly [brand]: true;
  readonly bin?: string;
  spawn(request: SpawnRequest): Promise<{ exitCode: number }>;
};

export function createWorkerAdapter(
  methods: Partial<Pick<WorkerAdapter, "spawn" | "bin">> = {},
): WorkerAdapter {
  return {
    [brand]: true,
    spawn() {
      return Promise.reject(new Error("Worker Adapter cannot spawn"));
    },
    ...methods,
  };
}
