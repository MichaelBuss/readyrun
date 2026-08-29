import { printModeWorker, type WorkerAdapter } from "../worker-adapter.ts";

export function cursor(): WorkerAdapter {
  return printModeWorker("agent", "--yolo");
}
