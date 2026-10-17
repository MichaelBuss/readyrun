import {
  captureProbeOutput,
  execListOutput,
  printModeWorker,
  stripAnsi,
  type ListedModel,
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

// `opencode models` prints one bare `provider/model` id per line (verified
// against opencode 1.18.31, #160): no `id - label` split, no markers, so it
// gets this sibling parser rather than a bent parseListedModels. Rows carry
// id == label so the same select/autocomplete surface as Cursor renders them.
export function parseBareModelIds(stdout: string): ListedModel[] {
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const id = stripAnsi(raw).trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

// The list reflects the providers the Consumer has actually configured, so it
// doubles as a soft auth signal — but a missing or unauthed CLI must not
// block Init (#160): zero lines or a failed spawn is an empty list, and the
// typed `provider/model` prompt takes over. Unlike Cursor there is no static
// fallback catalog: suggesting a model the CLI never listed would write a
// config the Worker cannot run.
export async function listOpencodeModels(): Promise<readonly ListedModel[]> {
  try {
    return parseBareModelIds(await execListOutput("opencode", ["models"]));
  } catch {
    return [];
  }
}

/**
 * The opencode Worker Adapter: `opencode run` — already non-interactive, so
 * `-i` is never passed — with `--dir {cwd}` pinning the Worker to its
 * Worktree (ADR 0036): opencode re-roots linked worktrees to the git common
 * dir, so process cwd is never trusted (#125). Unattended via `--auto`,
 * Effort via `--variant` in the declared `high` | `max` vocabulary,
 * health-probed with `auth list` judged for zero credentials. The model
 * question answers here too: the Adapter's own `models` command, its bare-id
 * grammar, an empty answer when nothing can be listed honestly (ADR 0047).
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
    listModels: listOpencodeModels,
  });
}
