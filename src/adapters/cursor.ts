import { codingCliWorker } from "./coding-cli.ts";
import type { WorkerAdapter } from "../worker-adapter.ts";

export function cursor(): WorkerAdapter {
  return codingCliWorker("agent", "--yolo");
}
