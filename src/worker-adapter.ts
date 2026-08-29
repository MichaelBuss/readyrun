import { spawn } from "node:child_process";
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

export function spawnWorkerBinary(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}

export function printModeWorker(
  bin: string,
  unattendedFlag: string,
): WorkerAdapter {
  return createWorkerAdapter({
    bin,
    spawn(request: SpawnRequest) {
      const args = ["-p", "--model", request.model];
      if (request.permissions === "unattended") {
        args.push(unattendedFlag);
      }
      args.push(request.prompt);
      return spawnWorkerBinary(bin, args, request.cwd);
    },
  });
}
