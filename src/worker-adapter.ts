import { spawn } from "node:child_process";
import type { Ticket } from "./ticket.ts";

const brand = Symbol("WorkerAdapter");

/**
 * How freely a Worker may act without asking: `"ask"` or `"unattended"`.
 * Default `"ask"`. The print-mode Adapters (`cursor()`, `claude()`,
 * `opencode()`) make `"ask"` a Doctor failure — pass `"unattended"`.
 * Vendor flags (`--yolo`, `--auto`, `--dangerously-skip-permissions`) stay
 * inside the Worker Adapter.
 */
export type Permissions = "ask" | "unattended";

/**
 * How hard a Worker thinks on a Ticket. The Run-level vocabulary is all
 * five values; a Worker Adapter declares which of them it can honestly
 * map, and Effort outside that declaration is a config lie Doctor fails.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The transport vocabulary `--effort` speaks. The truth about which values a
 * CLI accepts lives with the Worker Adapter, which declares the values it can
 * honestly map (ADR 0042); the standard CLIs take all five, in this order.
 */
export const standardEffortVocabulary = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** The Effort vocabulary the standard CLIs map: all five values, in order. */
export type StandardEffortVocabulary = typeof standardEffortVocabulary;

const efforts = new Set<string>(standardEffortVocabulary);

export function isEffort(value: string): value is Effort {
  return efforts.has(value);
}

/** The label the Launcher and Init render for a declared Effort value. */
export function effortLabel(value: Effort): string {
  switch (value) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
  }
}

/**
 * One spawn of a coding CLI: exactly one Ticket, in exactly one Worktree,
 * on that Ticket's Branch. The Adapter turns this into its CLI's argv.
 */
export type SpawnRequest = {
  /** The Ticket the Worker works; the only Ticket this process gets. */
  ticket: Ticket;
  /** The absolute path of the Ticket's Worktree. */
  cwd: string;
  /** The model for this spawn, already resolved. */
  model: string;
  /** How freely the Worker may act without asking. */
  permissions: Permissions;
  /** The Effort for this spawn, when one is in play. */
  effort?: Effort;
  /** The full prompt: loop rules, the Tracker Adapter's copy, the Worktree and Branch. */
  prompt: string;
  /**
   * Set only by Doctor's cwd-fidelity probe (ADR 0037): the Adapter must pipe
   * the Worker's output back instead of inheriting the terminal, and kill it
   * after timeoutMs. A Run's spawns set neither.
   */
  capture?: true;
  /** The kill timeout for a capture spawn; Doctor's probe only. */
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

/**
 * The coding-CLI-specific way to spawn a Worker: one Ticket, one Branch, one
 * Worktree per process. The shipped factories (`cursor()`, `claude()`,
 * `opencode()`, `custom()`) build one; a Consumer building its own uses
 * {@link createWorkerAdapter}.
 *
 * The Effort vocabulary an Adapter declares is part of its public shape
 * (ADR 0042): the values it can honestly map, typed so a Consumer config's
 * `effort` field is checked against exactly this declaration. Absent or empty
 * means the Adapter maps no Effort.
 */
export type WorkerAdapter<Vocabulary extends readonly Effort[] = readonly Effort[]> = {
  readonly [brand]: true;
  /** The CLI binary the Adapter spawns; unset for a purely bespoke spawn. */
  readonly bin?: string;
  /** The flag that passes Effort; required whenever a vocabulary is declared. */
  readonly effortFlag?: string;
  /** The Effort values the Adapter can honestly map; empty maps none. */
  readonly effortVocabulary?: Vocabulary;
  /** True when the Adapter spawns print mode, where `"ask"` cannot reach the Consumer. */
  readonly printMode?: true;
  /** The cheap health check Doctor runs (binary present, logged in). */
  readonly probe?: () => Promise<ProbeResult>;
  /** Extra argv the Adapter always passes, named by its option for Doctor's messages. */
  readonly staticArgv?: StaticArgv;
  /** Spawn one Worker for one Ticket. */
  spawn(request: SpawnRequest): Promise<SpawnResult>;
};

export function createWorkerAdapter<
  Vocabulary extends readonly Effort[] = readonly Effort[],
>(
  methods: Partial<
    Pick<
      WorkerAdapter<Vocabulary>,
      | "spawn"
      | "bin"
      | "effortFlag"
      | "effortVocabulary"
      | "printMode"
      | "probe"
      | "staticArgv"
    >
  > = {},
): WorkerAdapter<Vocabulary> {
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

// The capture machinery probes share: one invocation, stdout and stderr
// merged in arrival order, resolved with the exit code. A spawn error (the
// binary is not installed) rejects.
export function captureProbeOutput(
  bin: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

export function execProbe(bin: string, args: string[]): Promise<ProbeResult> {
  return captureProbeOutput(bin, args).then(
    ({ exitCode, output }) => {
      if (authFailureText.test(output)) {
        return { ok: false, detail: output.trim() };
      } else if (exitCode === 0) {
        return { ok: true };
      } else {
        return { ok: false, detail: output.trim() || `exited with code ${exitCode}` };
      }
    },
    (error: Error) => ({ ok: false, detail: error.message }),
  );
}

export type PrintModeWorkerOptions<Vocabulary extends readonly Effort[] = readonly Effort[]> = {
  effortFlag?: string;
  effortVocabulary?: Vocabulary;
  // The argv that puts the CLI into print mode, `{cwd}`-interpolated: a
  // leading flag (`-p`) or a leading subcommand with its own flags
  // (`run --dir {cwd}`). Defaults to `-p`, the shared CLIs' flag.
  leadingArgs?: string[];
  extraArgs?: string[];
  probeArgs?: string[];
  // A probe probeArgs cannot express: `opencode auth list` exits 0 whether
  // or not any credential exists, so its Adapter judges the captured output.
  probe?: () => Promise<ProbeResult>;
};

export function printModeWorker<Vocabulary extends readonly Effort[] = readonly Effort[]>(
  bin: string,
  unattendedFlag: string,
  options: PrintModeWorkerOptions<Vocabulary> = {},
): WorkerAdapter<Vocabulary> {
  const { effortFlag, effortVocabulary, leadingArgs, extraArgs, probeArgs, probe } = options;
  return createWorkerAdapter({
    bin,
    effortFlag,
    effortVocabulary,
    printMode: true,
    probe: probe ?? (probeArgs === undefined ? undefined : () => execProbe(bin, probeArgs)),
    staticArgv:
      extraArgs === undefined ? undefined : { option: "extraArgs", args: extraArgs },
    spawn(request: SpawnRequest) {
      const args = [
        ...interpolateCwdArgs(leadingArgs ?? ["-p"], request.cwd),
        ...interpolateCwdArgs(extraArgs ?? [], request.cwd),
        "--model",
        request.model,
      ];
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
