import type { Ticket } from "./ticket.ts";
import type { Landing, TrackerAdapter } from "./tracker-adapter.ts";
import type { Effort, Permissions, WorkerAdapter } from "./worker-adapter.ts";
import { assertKnownKeys } from "./unknown-keys.ts";

const knownConfigKeys = new Set([
  "tracker",
  "worker",
  "model",
  "modelsByLabel",
  "permissions",
  "effort",
  "contextFile",
  "cap",
  "leaveFrontier",
]);

// The config's `effort` field is typed against the chosen Worker Adapter's
// declared Effort vocabulary (ADR 0042): an out-of-vocabulary value is a
// compile error before Doctor ever runs. The vocabulary rides on the
// `worker` field's Adapter type, so it is inferred from the factory the
// Consumer picked.
export type ReadyRunConfig<Vocabulary extends readonly Effort[] = readonly Effort[]> = {
  tracker: TrackerAdapter;
  worker: WorkerAdapter<Vocabulary>;
  model: string;
  modelsByLabel?: Record<string, string>;
  permissions?: Permissions;
  effort?: Vocabulary[number];
  contextFile?: string;
  cap?: number;
  leaveFrontier?: (ticket: Ticket, landing: Landing) => void | Promise<void>;
};

export function defineConfig<Vocabulary extends readonly Effort[] = readonly Effort[]>(
  config: ReadyRunConfig<Vocabulary>,
): ReadyRunConfig<Vocabulary> & {
  permissions: Permissions;
} {
  assertKnownKeys(config, knownConfigKeys);
  return {
    ...config,
    permissions: config.permissions ?? "ask",
  };
}
