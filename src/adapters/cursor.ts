import {
  execListOutput,
  assembledWorker,
  stripAnsi,
  type ListedModel,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCursorKeys = new Set(["extraArgs"]);

/** Options for {@link cursor}: static argv beyond model/effort. */
export type CursorWorkerOptions = {
  /** One static vendor flag, landed next to `--model` at spawn. */
  extraArgs?: string[];
};

// `agent --list-models` prints an `Available models` heading, then one
// `id - label` row per model, with `(default)` or `(current)` marking the
// row to start from.
const listedMarker = /\s*\((default|current)\)\s*$/i;

export function parseListedModels(stdout: string): ListedModel[] {
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (
      line.length === 0 ||
      line === "Available models" ||
      line.startsWith("Tip:")
    ) {
      continue;
    }
    const idx = line.indexOf(" - ");
    if (idx < 0) {
      continue;
    }
    const id = line.slice(0, idx).trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    let label = line.slice(idx + 3).trim();
    const mark = label.match(listedMarker);
    if (mark?.index !== undefined) {
      label = label.slice(0, mark.index).trim();
    }
    seen.add(id);
    const model: ListedModel = {
      id,
      label: label.length > 0 ? label : id,
    };
    if (mark?.[1] !== undefined) {
      model.hint = mark[1].toLowerCase();
    }
    models.push(model);
  }
  return models;
}

// The static catalog Init's model question falls back to when neither
// listing binary answers — not installed, not authed, an output change — so
// the question stays answerable. The typed "Other…" prompt covers anything
// newer than this list.
const fallbackCursorModels: ListedModel[] = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "composer-2", label: "Composer 2" },
  { id: "auto", label: "Auto" },
];

// The listing binary has shipped under two names; try both, then the
// fallback catalog.
async function listCursorModels(): Promise<readonly ListedModel[]> {
  for (const bin of ["agent", "cursor-agent"]) {
    try {
      const models = parseListedModels(await execListOutput(bin, ["--list-models"]));
      if (models.length > 0) {
        return models;
      }
    } catch {
      // Try the next binary, then the fallback catalog.
    }
  }
  return fallbackCursorModels;
}

/**
 * The Cursor Worker Adapter: `agent` in print mode (`-p`), unattended via
 * `--yolo`, health-probed with `agent status`. Cursor takes Effort as a model
 * variant, not a flag, so it declares an empty Effort vocabulary (ADR 0042):
 * any config effort on this Adapter is a compile error, and Doctor fails what
 * slips through at runtime. The model question answers here too: the
 * Adapter's own `--list-models` listing, the fallback catalog when no
 * Cursor CLI answers (ADR 0047).
 */
export function cursor(options: CursorWorkerOptions = {}): WorkerAdapter<readonly []> {
  assertKnownKeys(options, knownCursorKeys);
  return assembledWorker<readonly []>("agent", "--yolo", {
    effortVocabulary: [],
    extraArgs: options.extraArgs,
    probeArgs: ["status"],
    listModels: listCursorModels,
  });
}
