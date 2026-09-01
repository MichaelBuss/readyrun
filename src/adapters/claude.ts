import { printModeWorker, type WorkerAdapter } from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownClaudeKeys = new Set(["extraArgs"]);

export type ClaudeWorkerOptions = {
  extraArgs?: string[];
};

export function claude(options: ClaudeWorkerOptions = {}): WorkerAdapter {
  assertKnownKeys(options, knownClaudeKeys);
  return printModeWorker(
    "claude",
    "--dangerously-skip-permissions",
    "--effort",
    options.extraArgs,
  );
}
