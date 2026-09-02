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
  readonly printMode?: true;
  readonly probe?: () => Promise<ProbeResult>;
  spawn(request: SpawnRequest): Promise<{ exitCode: number }>;
};

export function createWorkerAdapter(
  methods: Partial<Pick<WorkerAdapter, "spawn" | "bin" | "effortFlag" | "printMode" | "probe">> = {},
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

// Not every coding CLI's status/whoami command documents an exit code that
// distinguishes logged-in from not (Claude's `auth status` does; Cursor's
// `agent status` does not). Recognizing this text alongside the exit code
// keeps the probe honest for CLIs that always exit 0 but print the failure.
const authFailureText = /not authenticated|not logged in|unauthenticated|authentication required/i;

export function execProbe(bin: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, detail: error.message });
    });
    child.on("close", (code) => {
      if (authFailureText.test(output)) {
        resolve({ ok: false, detail: output.trim() });
      } else if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, detail: output.trim() || `exited with code ${code}` });
      }
    });
  });
}

export type PrintModeWorkerOptions = {
  effortFlag?: string;
  extraArgs?: string[];
  probeArgs?: string[];
};

export function printModeWorker(
  bin: string,
  unattendedFlag: string,
  options: PrintModeWorkerOptions = {},
): WorkerAdapter {
  const { effortFlag, extraArgs, probeArgs } = options;
  return createWorkerAdapter({
    bin,
    effortFlag,
    printMode: true,
    probe: probeArgs === undefined ? undefined : () => execProbe(bin, probeArgs),
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
