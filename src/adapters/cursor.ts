import {
  createWorkerAdapter,
  type WorkerAdapter,
} from "../worker-adapter.ts";

export function cursor(): WorkerAdapter {
  return createWorkerAdapter();
}
