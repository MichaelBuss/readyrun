import {
  createWorkerAdapter,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCustomKeys = new Set(["bin", "args", "unattendedFlag"]);

export type CustomWorkerOptions = {
  bin: string;
  args?: string[];
  unattendedFlag: string;
};

export type CustomWorkerAdapter = WorkerAdapter & {
  readonly options: CustomWorkerOptions;
};

export function custom(options: CustomWorkerOptions): CustomWorkerAdapter {
  assertKnownKeys(options, knownCustomKeys);
  return Object.assign(createWorkerAdapter({ bin: options.bin }), { options });
}
