import {
  createWorkerAdapter,
  spawnWorkerBinary,
  type SpawnRequest,
  type WorkerAdapter,
} from "../worker-adapter.ts";

export function codingCliWorker(
  bin: string,
  unattendedFlag: string,
): WorkerAdapter {
  return createWorkerAdapter({
    bin,
    spawn(request: SpawnRequest) {
      const args = ["-p", "--model", request.model];
      if (request.permissions === "unattended") {
        args.push(unattendedFlag);
      }
      args.push(request.prompt);
      return spawnWorkerBinary(bin, args, request.cwd);
    },
  });
}
