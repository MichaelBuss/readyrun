import { printModeWorker, type WorkerAdapter } from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCursorKeys = new Set(["extraArgs"]);

export type CursorWorkerOptions = {
  extraArgs?: string[];
};

export function cursor(options: CursorWorkerOptions = {}): WorkerAdapter {
  assertKnownKeys(options, knownCursorKeys);
  return printModeWorker("agent", "--yolo", { extraArgs: options.extraArgs });
}
