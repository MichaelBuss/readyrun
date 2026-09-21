import {
  printModeWorker,
  standardEffortVocabulary,
  type StandardEffortVocabulary,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownClaudeKeys = new Set(["extraArgs"]);

export type ClaudeWorkerOptions = {
  extraArgs?: string[];
};

export function claude(
  options: ClaudeWorkerOptions = {},
): WorkerAdapter<StandardEffortVocabulary> {
  assertKnownKeys(options, knownClaudeKeys);
  return printModeWorker("claude", "--dangerously-skip-permissions", {
    effortFlag: "--effort",
    effortVocabulary: standardEffortVocabulary,
    extraArgs: options.extraArgs,
    probeArgs: ["auth", "status"],
  });
}
