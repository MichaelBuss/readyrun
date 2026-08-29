import {
  createWorkerAdapter,
  spawnWorkerBinary,
  type SpawnRequest,
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
  return Object.assign(
    createWorkerAdapter({
      bin: options.bin,
      spawn(request: SpawnRequest) {
        const args = [
          ...(options.args ?? []),
          "--model",
          request.model,
          ...(request.permissions === "unattended" ? [options.unattendedFlag] : []),
          request.prompt,
        ];
        return spawnWorkerBinary(options.bin, args, request.cwd);
      },
    }),
    { options },
  );
}
