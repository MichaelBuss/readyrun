import {
  printModeWorker,
  spawnWorkerBinary,
  type ProbeResult,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

// opencode's effort knob is `--variant`, whose values are provider-specific
// (ADR 0042): the Adapter declares only the documented `high` | `max` until a
// Consumer's trial corrects the claim.
export const opencodeEffortVocabulary = ["high", "max"] as const;

export type OpencodeEffortVocabulary = typeof opencodeEffortVocabulary;

const knownOpencodeKeys = new Set(["extraArgs"]);

export type OpencodeWorkerOptions = {
  extraArgs?: string[];
};

// `auth list` exits 0 whether or not a credential exists (verified against
// opencode 1.18.31), so the probe judges the captured output: zero credentials
// is installed-but-not-logged-in, a spawn error is not installed, and the
// output rides along as the detail either way. \b keeps "10 credentials" out.
const zeroCredentials = /\b0 credentials/;

async function probeAuthList(): Promise<ProbeResult> {
  let result;
  try {
    result = await spawnWorkerBinary("opencode", ["auth", "list"], process.cwd(), {
      capture: true,
    });
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.exitCode !== 0) {
    return { ok: false, detail: output || `exited with code ${result.exitCode}` };
  }
  if (zeroCredentials.test(output)) {
    return { ok: false, detail: output };
  }
  return { ok: true };
}

// Print mode is `opencode run` — already non-interactive, so `-i` is never
// passed — and `--dir {cwd}` pins the Worker to its Worktree (ADR 0036):
// opencode re-roots linked worktrees to the git common dir, so process cwd is
// never trusted (#125).
export function opencode(
  options: OpencodeWorkerOptions = {},
): WorkerAdapter<OpencodeEffortVocabulary> {
  assertKnownKeys(options, knownOpencodeKeys);
  return printModeWorker("opencode", "--auto", {
    effortFlag: "--variant",
    effortVocabulary: opencodeEffortVocabulary,
    leadingArgs: ["run", "--dir", "{cwd}"],
    extraArgs: options.extraArgs,
    probe: probeAuthList,
  });
}
