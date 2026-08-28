import type { TrackerAdapter } from "./tracker-adapter.ts";
import type { WorkerAdapter } from "./worker-adapter.ts";
import { assertKnownKeys } from "./unknown-keys.ts";

const knownConfigKeys = new Set([
  "tracker",
  "worker",
  "model",
  "modelsByLabel",
  "permissions",
  "contextFile",
  "cap",
]);

export type ReadyRunConfig = {
  tracker: TrackerAdapter;
  worker: WorkerAdapter;
  model: string;
  modelsByLabel?: Record<string, string>;
  permissions?: "ask" | "unattended";
  contextFile?: string;
  cap?: number;
};

export function defineConfig<T extends ReadyRunConfig>(config: T): T & {
  permissions: "ask" | "unattended";
} {
  assertKnownKeys(config, knownConfigKeys);
  return {
    ...config,
    permissions: config.permissions ?? "ask",
  };
}
