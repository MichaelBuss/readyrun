import {
  createWorkerAdapter,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCustomKeys = new Set(["bin", "args"]);

export type CustomWorkerOptions = {
  bin: string;
  args?: string[];
};

export function custom(options: CustomWorkerOptions): WorkerAdapter {
  assertKnownKeys(options, knownCustomKeys);
  return Object.assign(createWorkerAdapter(), { options });
}
