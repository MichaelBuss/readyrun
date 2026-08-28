import {
  createWorkerAdapter,
  type WorkerAdapter,
} from "../worker-adapter.ts";

export function claude(): WorkerAdapter {
  return createWorkerAdapter();
}
