import { spawn } from "node:child_process";
import type { Ticket } from "./ticket.ts";

const brand = Symbol("WorkerAdapter");

export type Permissions = "ask" | "unattended";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const efforts = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export function isEffort(value: string): value is Effort {
  return efforts.has(value);
}

export type SpawnRequest = {
  ticket: Ticket;
  cwd: string;
  model: string;
  permissions: Permissions;
  effort?: Effort;
  prompt: string;
};

export type ProbeResult = { ok: true } | { ok: false; detail: string };

export type WorkerAdapter = {
  readonly [brand]: true;
  readonly bin?: string;
  readonly effortFlag?: string;
  readonly probe?: () => Promise<ProbeResult>;
  spawn(request: SpawnRequest): Promise<{ exitCode: number }>;
};

export function createWorkerAdapter(
  methods: Partial<Pick<WorkerAdapter, "spawn" | "bin" | "effortFlag" | "probe">> = {},
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

export type PrintModeWorkerOptions = {
  effortFlag?: string;
  extraArgs?: string[];
};

export function printModeWorker(
  bin: string,
  unattendedFlag: string,
  options: PrintModeWorkerOptions = {},
): WorkerAdapter {
  const { effortFlag, extraArgs } = options;
  return createWorkerAdapter({
    bin,
    effortFlag,
    spawn(request: SpawnRequest) {
      const args = ["-p", ...(extraArgs ?? []), "--model", request.model];
      if (request.effort !== undefined && effortFlag !== undefined) {
        args.push(effortFlag, request.effort);
      }
      if (request.permissions === "unattended") {
        args.push(unattendedFlag);
      }
      args.push(request.prompt);
      return spawnWorkerBinary(bin, args, request.cwd);
    },
  });
}
