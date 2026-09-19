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
  // Set only by Doctor's cwd-fidelity probe (ADR 0037): the Adapter must pipe
  // the Worker's output back instead of inheriting the terminal, and kill it
  // after timeoutMs. A Run's spawns set neither.
  capture?: true;
  timeoutMs?: number;
};

// A capture spawn answers with what the Worker printed; an inherit spawn
// (a Run's) answers with the exit code alone.
export type SpawnResult = {
  exitCode: number;
  timedOut?: true;
  stdout?: string;
  stderr?: string;
};

export type ProbeResult = { ok: true } | { ok: false; detail: string };

export type StaticArgv = { option: string; args: string[] };

export type WorkerAdapter = {
  readonly [brand]: true;
  readonly bin?: string;
  readonly effortFlag?: string;
  readonly printMode?: true;
  readonly probe?: () => Promise<ProbeResult>;
  readonly staticArgv?: StaticArgv;
  spawn(request: SpawnRequest): Promise<SpawnResult>;
};

export function createWorkerAdapter(
  methods: Partial<Pick<WorkerAdapter, "spawn" | "bin" | "effortFlag" | "printMode" | "probe" | "staticArgv">> = {},
): WorkerAdapter {
  return {
    [brand]: true,
    spawn() {
      return Promise.reject(new Error("Worker Adapter cannot spawn"));
    },
    ...methods,
  };
}

const cwdPlaceholder = "{cwd}";

const placeholderShape = /\{[^{}]+\}/g;

export function interpolateCwdArgs(args: string[], cwd: string): string[] {
  return args.map((arg) => arg.replaceAll(cwdPlaceholder, cwd));
}

export function unknownPlaceholdersIn(arg: string): string[] {
  const unknown: string[] = [];
  for (const match of arg.matchAll(placeholderShape)) {
    if (match[0] !== cwdPlaceholder) {
      unknown.push(match[0]);
    }
  }
  return unknown;
}

export function spawnWorkerBinary(
  bin: string,
  args: string[],
  cwd: string,
  options: { capture?: boolean; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const { capture, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (capture && timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        // A probe Worker that ignores its exit has no say: Doctor must not
        // hang on it. SIGKILL because the child never agreed to be asked.
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: code ?? 1,
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(capture ? { stdout, stderr } : {}),
      });
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
    staticArgv:
      extraArgs === undefined ? undefined : { option: "extraArgs", args: extraArgs },
    spawn(request: SpawnRequest) {
      const args = ["-p", ...interpolateCwdArgs(extraArgs ?? [], request.cwd), "--model", request.model];
      if (request.effort !== undefined && effortFlag !== undefined) {
        args.push(effortFlag, request.effort);
      }
      if (request.permissions === "unattended") {
        args.push(unattendedFlag);
      }
      args.push(request.prompt);
      return spawnWorkerBinary(bin, args, request.cwd, {
        capture: request.capture,
        timeoutMs: request.timeoutMs,
      });
    },
  });
}
