import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import { originRepository, normalizeRepository } from "./git.ts";
import type { Ticket } from "./ticket.ts";
import type { Effort, Permissions } from "./worker-adapter.ts";

type DoctorStdout = { write(chunk: string): unknown };

export type DoctorOptions = {
  config: ReadyRunConfig;
  cwd?: string;
  stdout?: DoctorStdout;
};

async function check(
  config: ReadyRunConfig,
  cwd: string,
  effort: Effort | undefined,
  permissions: Permissions,
): Promise<string[]> {
  const failures: string[] = [];
  if (typeof config.model !== "string" || config.model.length === 0) {
    failures.push("missing model default");
  }
  let inspect;
  try {
    inspect = await config.tracker.inspect();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return failures;
  }
  for (const label of inspect.selectorLabels) {
    if (!inspect.existingLabels.includes(label)) {
      failures.push(`label "${label}" does not exist on the Tracker`);
    }
  }
  if (
    inspect.selectorState !== undefined &&
    !(inspect.existingStates ?? []).includes(inspect.selectorState)
  ) {
    failures.push(`state "${inspect.selectorState}" does not exist on the Tracker`);
  }
  if (
    inspect.selectorProject !== undefined &&
    !(inspect.existingProjects ?? []).includes(inspect.selectorProject)
  ) {
    failures.push(
      `project "${inspect.selectorProject}" does not exist on the Tracker`,
    );
  }
  if (inspect.repository !== undefined) {
    const remote = await originRepository(cwd);
    if (
      remote === undefined ||
      normalizeRepository(remote) !== normalizeRepository(inspect.repository)
    ) {
      failures.push(
        `configured repository ${inspect.repository} is not the git remote (${remote ?? "none"})`,
      );
    }
  }
  if (!inspect.canExpressBlocking) {
    failures.push(
      "Tracker cannot express blocking; unblocked ordering is a lie",
    );
  }
  if (config.worker.bin !== undefined && !workerBinaryExists(config.worker.bin)) {
    failures.push(`Worker binary "${config.worker.bin}" is missing`);
  } else if (config.worker.probe !== undefined) {
    const probeResult = await config.worker.probe();
    if (!probeResult.ok) {
      failures.push(`Worker Adapter probe failed: ${probeResult.detail}`);
    }
  }
  if (effort !== undefined && config.worker.effortFlag === undefined) {
    failures.push("effort is set but this Worker Adapter does not map it");
  }
  if (config.worker.printMode === true && permissions === "ask") {
    failures.push(
      "print-mode spawn cannot use permissions ask; pass --permissions unattended",
    );
  }
  return failures;
}

function workerBinaryExists(bin: string): boolean {
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return existsSync(bin);
  }
  const path = process.env.PATH ?? "";
  return path.split(delimiter).some((dir) => existsSync(join(dir, bin)));
}

export function warnUnusedModelsByLabel(
  stdout: DoctorStdout,
  modelsByLabel: Record<string, string> | undefined,
  frontier: Ticket[],
): void {
  if (modelsByLabel === undefined) {
    return;
  }
  const present = new Set(frontier.flatMap((ticket) => ticket.labels));
  for (const label of Object.keys(modelsByLabel)) {
    if (!present.has(label)) {
      stdout.write(
        `Warning: modelsByLabel key "${label}" matches no Tickets on the Frontier\n`,
      );
    }
  }
}

export async function doctorCheck(
  config: ReadyRunConfig,
  cwd: string,
  stdout: DoctorStdout,
  effort: Effort | undefined = config.effort,
  permissions: Permissions = config.permissions ?? "ask",
): Promise<0 | 1> {
  const failures = await check(config, cwd, effort, permissions);
  if (failures.length === 0) {
    return 0;
  }
  for (const failure of failures) {
    stdout.write(`Doctor: ${failure}\n`);
  }
  return 1;
}

export async function doctor(options: DoctorOptions): Promise<number> {
  const config = defineConfig(options.config);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  if (await doctorCheck(config, cwd, stdout) === 1) {
    return 1;
  }
  const frontier = await config.tracker.frontier();
  warnUnusedModelsByLabel(stdout, config.modelsByLabel, frontier);
  const next = frontier[0];
  if (next === undefined) {
    stdout.write("Frontier is empty\n");
  } else {
    stdout.write(`Next Ticket: ${next.id}\n`);
  }
  return 0;
}
