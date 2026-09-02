import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createWorkerAdapter,
  type SpawnRequest,
  type WorkerAdapter,
} from "../worker-adapter.ts";

const exec = promisify(execFile);

// What the double leaves behind in the Worktree it was spawned in. The default
// is "committed", because that is what the prompt tells a Worker to do.
export type LeftWork = "committed" | "uncommitted" | "none";

export type RecordingWorkerOptions = {
  exitCode?: number;
  work?: LeftWork;
};

export type RecordingWorker = WorkerAdapter & {
  readonly spawns: readonly SpawnRequest[];
};

export function recordingWorker(
  options: RecordingWorkerOptions = {},
): RecordingWorker {
  const spawns: SpawnRequest[] = [];
  const exitCode = options.exitCode ?? 0;
  const work = options.work ?? "committed";

  return Object.assign(
    createWorkerAdapter({
      effortFlag: "--effort",
      async spawn(request: SpawnRequest) {
        spawns.push(request);
        await leaveWork(work, request);
        return { exitCode };
      },
    }),
    { spawns },
  );
}

async function leaveWork(
  work: LeftWork,
  request: SpawnRequest,
): Promise<void> {
  if (work === "none") {
    return;
  }
  const file = `ticket-${request.ticket.id}.txt`;
  await writeFile(join(request.cwd, file), `${request.ticket.title}\n`);
  if (work === "uncommitted") {
    return;
  }
  await exec("git", ["-C", request.cwd, "add", "--", file]);
  await exec("git", [
    "-C",
    request.cwd,
    "commit",
    "-m",
    `Ticket ${request.ticket.id}`,
  ]);
}
