import {
  printModeWorker,
  standardEffortVocabulary,
  type StandardEffortVocabulary,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownClaudeKeys = new Set(["extraArgs"]);

/** Options for {@link claude}: static argv beyond model/effort. */
export type ClaudeWorkerOptions = {
  /** One static vendor flag, landed next to `--effort` at spawn. */
  extraArgs?: string[];
};

/**
 * The Claude Worker Adapter: `claude` in print mode (`-p`), unattended via
 * `--dangerously-skip-permissions`, Effort via `--effort` across the full
 * standard vocabulary, health-probed with `claude auth status`.
 */
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
