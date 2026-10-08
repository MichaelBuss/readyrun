import { printModeWorker, type WorkerAdapter } from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCursorKeys = new Set(["extraArgs"]);

/** Options for {@link cursor}: static argv beyond model/effort. */
export type CursorWorkerOptions = {
  /** One static vendor flag, landed next to `--model` at spawn. */
  extraArgs?: string[];
};

/**
 * The Cursor Worker Adapter: `agent` in print mode (`-p`), unattended via
 * `--yolo`, health-probed with `agent status`. Cursor takes Effort as a model
 * variant, not a flag, so it declares an empty Effort vocabulary (ADR 0042):
 * any config effort on this Adapter is a compile error, and Doctor fails what
 * slips through at runtime.
 */
export function cursor(options: CursorWorkerOptions = {}): WorkerAdapter<readonly []> {
  assertKnownKeys(options, knownCursorKeys);
  return printModeWorker<readonly []>("agent", "--yolo", {
    effortVocabulary: [],
    extraArgs: options.extraArgs,
    probeArgs: ["status"],
  });
}
