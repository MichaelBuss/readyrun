import {
  createWorkerAdapter,
  type SpawnRequest,
  type WorkerAdapter,
} from "../worker-adapter.ts";

export type RecordingWorkerOptions = {
  exitCode?: number;
};

export type RecordingWorker = WorkerAdapter & {
  readonly spawns: readonly SpawnRequest[];
};

export function recordingWorker(
  options: RecordingWorkerOptions = {},
): RecordingWorker {
  const spawns: SpawnRequest[] = [];
  const exitCode = options.exitCode ?? 0;

  return Object.assign(
    createWorkerAdapter({
      spawn(request: SpawnRequest) {
        spawns.push(request);
        return Promise.resolve({ exitCode });
      },
    }),
    { spawns },
  );
}
