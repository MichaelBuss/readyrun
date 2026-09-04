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

export type ReadyRunConfig = {
  tracker: TrackerAdapter;
  worker: WorkerAdapter;
  model: string;
  modelsByLabel?: Record<string, string>;
  permissions?: Permissions;
  effort?: Effort;
  contextFile?: string;
  cap?: number;
  leaveFrontier?: (ticket: Ticket, landing: Landing) => void | Promise<void>;
};

export function defineConfig<T extends ReadyRunConfig>(config: T): T & {
  permissions: Permissions;
} {
  assertKnownKeys(config, knownConfigKeys);
  return {
    ...config,
    permissions: config.permissions ?? "ask",
  };
}
