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

/**
 * The Consumer's config, as `readyrun.config.ts` default-exports it. The
 * `effort` field is typed against the chosen Worker Adapter's declared
 * Effort vocabulary (ADR 0042): an out-of-vocabulary value is a compile
 * error before Doctor ever runs. The vocabulary rides on the `worker`
 * field's Adapter type, so it is inferred from the factory the Consumer
 * picked.
 */
export type ReadyRunConfig<Vocabulary extends readonly Effort[] = readonly Effort[]> = {
  /** The Tracker Adapter that maps the Tracker's work onto Tickets. */
  tracker: TrackerAdapter;
  /** The Worker Adapter that spawns one coding CLI process per Ticket. */
  worker: WorkerAdapter<Vocabulary>;
  /** The default model every Worker gets unless overridden per Run or per label. */
  model: string;
  /** Per-label model overrides; a key matching no Tickets warns, never fails. */
  modelsByLabel?: Record<string, string>;
  /**
   * How freely a Worker may act without asking: `"ask"` (default) or
   * `"unattended"`. Print-mode Adapters refuse `"ask"`.
   */
  permissions?: Permissions;
  /** The default Effort; must be in the Adapter's declared vocabulary. */
  effort?: Vocabulary[number];
  /** A repo file appended to every Worker prompt; does not replace Tracker copy. */
  contextFile?: string;
  /** The default cap when `--max` is not passed. */
  cap?: number;
  /**
   * Where a finished Ticket goes when it leaves the Frontier, instead of the
   * Tracker Adapter's default (GitHub: drop the frontier label and comment;
   * Linear: In Review). Receives the Ticket and its Landing.
   */
  leaveFrontier?: (ticket: Ticket, landing: Landing) => void | Promise<void>;
};

/**
 * The one way to write a Consumer config: supply the Adapter factories and
 * settings, and get `permissions` defaulted to `"ask"`. Unknown keys throw
 * {@link UnknownConfigKeyError} rather than passing silently.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   tracker: github({ repo: "owner/name", ready: "unblocked", labels: ["ready-for-agent"] }),
 *   worker: claude(),
 *   model: "sonnet",
 * });
 * ```
 */
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
