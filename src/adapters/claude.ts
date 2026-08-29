import { codingCliWorker } from "./coding-cli.ts";
import type { WorkerAdapter } from "../worker-adapter.ts";

export function claude(): WorkerAdapter {
  return codingCliWorker("claude", "--dangerously-skip-permissions");
}
