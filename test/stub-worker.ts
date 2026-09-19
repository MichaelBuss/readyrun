import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SpawnReceipt = {
  bin: string;
  argv: string[];
  cwd: string;
};

// The stub plays both sides of the cwd-fidelity probe (ADR 0037): when its
// last argv is the Doctor's probe prompt it is the probe's Worker and answers
// with its own cwd unless told otherwise; otherwise it is a Ticket Worker.
export const stubSource = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
writeFileSync(process.env.READYRUN_SPAWN_RECEIPT, JSON.stringify({
  bin: basename(process.argv[1]),
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}));
const probePrompt = "Print the output of \\\`git rev-parse --show-toplevel\\\` and nothing else.";
if (process.argv.at(-1) === probePrompt) {
  const stdout = process.env.READYRUN_PROBE_STDOUT;
  if (stdout === undefined) {
    process.stdout.write(process.cwd());
  } else {
    process.stdout.write(stdout);
  }
  if (process.env.READYRUN_PROBE_HANG === "1") {
    setInterval(() => {}, 60_000);
  } else {
    process.exitCode = Number(process.env.READYRUN_PROBE_EXIT_CODE ?? "0");
  }
} else {
  if (process.env.READYRUN_STUB_STDOUT !== undefined) {
    process.stdout.write(process.env.READYRUN_STUB_STDOUT);
  }
  process.exitCode = Number(process.env.READYRUN_STUB_EXIT_CODE ?? "0");
}
`;

const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

export async function withRecordingPath(
  names: string[],
  fn: (paths: { bin: string; receiptPath: string }) => Promise<void>,
): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(join(tmpRoot, "bin-"));
  const receiptPath = join(dir, "receipt.json");
  for (const name of names) {
    await writeFile(join(dir, name), stubSource, { mode: 0o755 });
  }
  const previousPath = process.env.PATH;
  const previousReceipt = process.env.READYRUN_SPAWN_RECEIPT;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  process.env.READYRUN_SPAWN_RECEIPT = receiptPath;
  try {
    await fn({ bin: join(dir, names[0] ?? "stub"), receiptPath });
  } finally {
    process.env.PATH = previousPath;
    if (previousReceipt === undefined) {
      delete process.env.READYRUN_SPAWN_RECEIPT;
    } else {
      process.env.READYRUN_SPAWN_RECEIPT = previousReceipt;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readReceipt(receiptPath: string): Promise<SpawnReceipt> {
  return JSON.parse(await readFile(receiptPath, "utf8")) as SpawnReceipt;
}
