import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDetachedWorktree,
  pruneWorktrees,
  removeWorktree,
} from "./git.ts";
import type { Ticket } from "./ticket.ts";
import type { SpawnRequest, WorkerAdapter } from "./worker-adapter.ts";

// The probe makes a real model call on a trivial prompt, so it must answer
// quickly; a Worker that hangs is a Doctor failure, not a Doctor hang.
const cwdProbeTimeoutMs = 60_000;

const cwdProbePrompt =
  "Print the output of `git rev-parse --show-toplevel` and nothing else.";

const worktreeParentPrefix = "readyrun-cwd-probe-";

const probeTicket: Ticket = {
  id: "cwd-fidelity",
  title: "Doctor's cwd-fidelity probe",
  body: "",
  url: "",
  labels: [],
  blockedBy: [],
};

export type CwdProbeOptions = {
  model: string;
  timeoutMs?: number;
};

// Doctor-owned and distinct from the Adapter's optional auth `probe()` (ADR
// 0023): this one spawns the real Worker through the Adapter's own spawn, in
// a throwaway Worktree, and asserts the Worker answered with that Worktree
// (ADR 0037). Returns the failure sentence for Doctor's failure list, or
// undefined when the Worker named the Worktree it ran in.
export async function probeCwdFidelity(
  worker: WorkerAdapter,
  repoCwd: string,
  options: CwdProbeOptions,
): Promise<string | undefined> {
  let parent: string | undefined;
  let worktreePath: string | undefined;
  try {
    parent = await mkdtemp(join(tmpdir(), worktreeParentPrefix));
    worktreePath = join(parent, "worktree");
    await addDetachedWorktree(repoCwd, worktreePath);
    const result = await worker.spawn({
      ticket: probeTicket,
      cwd: worktreePath,
      model: options.model,
      // Doctor has nobody to answer a prompt, so the probe always spawns
      // unattended; ask-mode print adapters are refused by Doctor anyway.
      permissions: "unattended",
      prompt: cwdProbePrompt,
      capture: true,
      timeoutMs: options.timeoutMs ?? cwdProbeTimeoutMs,
    });
    if (result.timedOut === true) {
      return `Worker Adapter cwd-fidelity probe timed out after ${seconds(options.timeoutMs ?? cwdProbeTimeoutMs)} without exiting.`;
    }
    const printed = (result.stdout ?? "").trim();
    if (printed === "") {
      const stderr = (result.stderr ?? "").trim();
      return `Worker Adapter cwd-fidelity probe produced no output${
        stderr === "" ? "" : `: ${firstLine(stderr)}`
      }; it must answer with the Worktree it ran in.`;
    }
    const expected = await realpath(worktreePath);
    if (!(await namesWorktreePath(printed, expected))) {
      return `Worker Adapter re-roots linked worktrees: the probe Worktree is ${expected} but the Worker answered "${firstLine(printed)}". Configure a Worktree anchor ({cwd} or its equivalent) in the Adapter's args before running.`;
    }
    return undefined;
  } catch (error) {
    return `Worker Adapter cwd-fidelity probe failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    if (parent !== undefined && worktreePath !== undefined) {
      await discardProbeWorktree(repoCwd, parent, worktreePath);
    }
  }
}

async function namesWorktreePath(
  printed: string,
  expected: string,
): Promise<boolean> {
  if (printed.includes(expected)) {
    return true;
  }
  // A CLI may answer with the un-resolved path (/var vs /private/var) or
  // decorate it; resolve both sides before calling it a lie.
  try {
    return (await realpath(printed)) === expected;
  } catch {
    return false;
  }
}

// Cleanup happens on every outcome, pass or fail: the Worktree's contents are
// the probe's answer, nothing worth keeping, and the temp parent goes with it.
async function discardProbeWorktree(
  repoCwd: string,
  parent: string,
  worktreePath: string,
): Promise<void> {
  try {
    await removeWorktree(repoCwd, worktreePath);
  } catch {
    // The rm below still decides the outcome on disk.
  }
  await rm(parent, { recursive: true, force: true });
  // If the remove failed and the rm did the work, git's admin state for the
  // Worktree lingers; prune clears it.
  try {
    await pruneWorktrees(repoCwd);
  } catch {
    // Hygiene only.
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}
