import {
  captureProbeOutput,
  printModeWorker,
  type ProbeResult,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

/**
 * opencode's effort knob is `--variant`, whose values are provider-specific
 * (ADR 0042): the Adapter declares only the documented `high` | `max` until a
 * Consumer's trial corrects the claim.
 */
export const opencodeEffortVocabulary = ["high", "max"] as const;

/** The Effort values {@link opencode} can honestly map: `high` and `max`. */
export type OpencodeEffortVocabulary = typeof opencodeEffortVocabulary;

/** Options for {@link opencode}: static argv beyond model/effort. */
export type OpencodeWorkerOptions = {
  /** One static vendor flag, landed next to `--variant` at spawn. */
  extraArgs?: string[];
};

const knownOpencodeKeys = new Set(["extraArgs"]);

// `auth list` exits 0 whether or not a credential exists (verified against
// opencode 1.18.31), so the probe judges the captured output: zero credentials
// is installed-but-not-logged-in, a spawn error is not installed, and the
// output rides along as the detail either way. \b keeps "10 credentials" out.
const zeroCredentials = /\b0 credentials/;

async function probeAuthList(): Promise<ProbeResult> {
  let result;
  try {
    result = await captureProbeOutput("opencode", ["auth", "list"]);
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const output = result.output.trim();
  if (result.exitCode !== 0) {
    return { ok: false, detail: output || `exited with code ${result.exitCode}` };
  }
  if (zeroCredentials.test(output)) {
    return { ok: false, detail: output };
  }
  return { ok: true };
}

/**
 * The opencode Worker Adapter: `opencode run` — already non-interactive, so
 * `-i` is never passed — with `--dir {cwd}` pinning the Worker to its
 * Worktree (ADR 0036): opencode re-roots linked worktrees to the git common
 * dir, so process cwd is never trusted (#125). Unattended via `--auto`,
 * Effort via `--variant` in the declared `high` | `max` vocabulary,
 * health-probed with `auth list` judged for zero credentials.
 */
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
