import { createWorkerAdapter, type WorkerAdapter } from "../worker-adapter.ts";

export type RecordingWorkerOptions = {
  exitCode?: number;
};

export type RecordingWorker = WorkerAdapter & {
  readonly spawns: readonly unknown[];
  spawn(request: unknown): Promise<{ exitCode: number }>;
};

export function recordingWorker(
  options: RecordingWorkerOptions = {},
): RecordingWorker {
  const spawns: unknown[] = [];
  const exitCode = options.exitCode ?? 0;

  return Object.assign(createWorkerAdapter(), {
    spawns,
    spawn(request: unknown) {
      spawns.push(request);
      return Promise.resolve({ exitCode });
    },
  });
}
