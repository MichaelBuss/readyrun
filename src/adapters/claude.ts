import { printModeWorker, type WorkerAdapter } from "../worker-adapter.ts";

export function claude(): WorkerAdapter {
  return printModeWorker("claude", "--dangerously-skip-permissions", "--effort");
}
