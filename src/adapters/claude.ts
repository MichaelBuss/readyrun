import {
  assembledWorker,
  standardEffortVocabulary,
  type ListedModel,
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

// Claude Code has no models command to ask: this static catalog is the
// Adapter's answer to the model question, and the typed "Other…" prompt
// covers anything newer than the list.
const claudeModels: ListedModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

/**
 * The Claude Worker Adapter: `claude` in print mode (`-p`), unattended via
 * `--dangerously-skip-permissions`, Effort via `--effort` across the full
 * standard vocabulary, health-probed with `claude auth status`. The model
 * question answers here too: the static catalog, no listing command to
 * spawn (ADR 0047).
 */
export function claude(
  options: ClaudeWorkerOptions = {},
): WorkerAdapter<StandardEffortVocabulary> {
  assertKnownKeys(options, knownClaudeKeys);
  return assembledWorker("claude", "--dangerously-skip-permissions", {
    effortFlag: "--effort",
    effortVocabulary: standardEffortVocabulary,
    extraArgs: options.extraArgs,
    probeArgs: ["auth", "status"],
    listModels: async () => claudeModels,
  });
}
