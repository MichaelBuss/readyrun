import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  autocomplete,
  cancel,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";
import { ensureReadyrunGitignored } from "./gitignore.ts";
import { claude } from "./adapters/claude.ts";
import { cursor } from "./adapters/cursor.ts";
import { custom } from "./adapters/custom.ts";
import { opencode, opencodeEffortVocabulary } from "./adapters/opencode.ts";
import { originRepository } from "./git.ts";
import {
  effortLabel,
  isEffort,
  listedModels,
  standardEffortVocabulary,
  type Effort,
  type WorkerAdapter,
} from "./worker-adapter.ts";

const otherModel = "__other__";

export type InitTracker =
  | {
      kind: "github";
      repo: string;
      labels: string[];
    }
  | {
      kind: "linear";
      state?: string;
      label?: string;
      project?: string;
    };

export type InitWorker =
  | { kind: "cursor" }
  | { kind: "claude" }
  | { kind: "opencode" }
  | { kind: "custom"; bin: string; unattendedFlag: string };

/**
 * What Init collected, from Clack or `--answers`: which Tracker, which
 * Worker Adapter, the default model, and an optional Effort in the Adapter's
 * declared vocabulary.
 */
export type InitAnswers = {
  /** The Tracker and its Frontier selector. */
  tracker: InitTracker;
  /** The Worker Adapter to write into the stub. */
  worker: InitWorker;
  /** The default model for the config stub. */
  model: string;
  /** The default Effort, when the Adapter maps one. */
  effort?: Effort;
};

/** What {@link init} takes: where to write and, for the scriptable path, the answers. */
export type InitOptions = {
  /** The Consumer root the stub is written into. */
  cwd: string;
  /** The answers, taking Clack's place; absent means prompt. */
  answers?: InitAnswers;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraKeys(value: object, known: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !known.has(key));
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseInitTracker(
  value: unknown,
): { ok: true; tracker: InitTracker } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Answers must include a tracker" };
  }
  if (value.kind === "github") {
    const extra = extraKeys(value, new Set(["kind", "repo", "labels"]));
    if (extra.length > 0) {
      return { ok: false, message: `Unknown tracker key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}` };
    }
    const repo = requiredString(value.repo);
    if (repo === undefined) {
      return { ok: false, message: "GitHub tracker requires a repo" };
    }
    if (!Array.isArray(value.labels)) {
      return { ok: false, message: "GitHub tracker requires labels" };
    }
    const labels: string[] = [];
    for (const label of value.labels) {
      if (typeof label !== "string") {
        return { ok: false, message: "GitHub tracker requires labels" };
      }
      const trimmed = label.trim();
      if (trimmed.length > 0) {
        labels.push(trimmed);
      }
    }
    if (labels.length === 0) {
      return { ok: false, message: "GitHub tracker requires labels" };
    }
    return { ok: true, tracker: { kind: "github", repo, labels } };
  }
  if (value.kind === "linear") {
    const extra = extraKeys(value, new Set(["kind", "state", "label", "project"]));
    if (extra.length > 0) {
      return { ok: false, message: `Unknown tracker key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}` };
    }
    const state = requiredString(value.state);
    const label = requiredString(value.label);
    const project = requiredString(value.project);
    const selectors = [state, label, project].filter((selector) => selector !== undefined);
    if (selectors.length !== 1) {
      return { ok: false, message: "Linear tracker requires a state, label, or project" };
    }
    if (state !== undefined) {
      return { ok: true, tracker: { kind: "linear", state } };
    }
    if (project !== undefined) {
      return { ok: true, tracker: { kind: "linear", project } };
    }
    if (label === undefined) {
      return { ok: false, message: "Linear tracker requires a state, label, or project" };
    }
    return { ok: true, tracker: { kind: "linear", label } };
  }
  return { ok: false, message: "Tracker must be github or linear" };
}

function parseInitWorker(
  value: unknown,
): { ok: true; worker: InitWorker } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Answers must include a worker" };
  }
  if (value.kind === "cursor" || value.kind === "claude" || value.kind === "opencode") {
    const extra = extraKeys(value, new Set(["kind"]));
    if (extra.length > 0) {
      return { ok: false, message: `Unknown worker key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}` };
    }
    return { ok: true, worker: { kind: value.kind } };
  }
  if (value.kind === "custom") {
    const extra = extraKeys(value, new Set(["kind", "bin", "unattendedFlag"]));
    if (extra.length > 0) {
      return { ok: false, message: `Unknown worker key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}` };
    }
    const bin = requiredString(value.bin);
    const unattendedFlag = requiredString(value.unattendedFlag);
    if (bin === undefined || unattendedFlag === undefined) {
      return { ok: false, message: "Custom worker requires a bin and unattendedFlag" };
    }
    return { ok: true, worker: { kind: "custom", bin, unattendedFlag } };
  }
  return { ok: false, message: "Worker must be cursor, claude, opencode, or custom" };
}

export function parseInitAnswers(
  value: unknown,
): { ok: true; answers: InitAnswers } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Answers must be a JSON object" };
  }
  const extra = extraKeys(value, new Set(["tracker", "worker", "model", "effort"]));
  if (extra.length > 0) {
    return {
      ok: false,
      message: `Unknown answers key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`,
    };
  }
  const tracker = parseInitTracker(value.tracker);
  if (!tracker.ok) {
    return tracker;
  }
  const worker = parseInitWorker(value.worker);
  if (!worker.ok) {
    return worker;
  }
  const model = requiredString(value.model);
  if (model === undefined) {
    return { ok: false, message: "Answers must include a model" };
  }
  if (value.effort === undefined) {
    return { ok: true, answers: { tracker: tracker.tracker, worker: worker.worker, model } };
  }
  if (typeof value.effort !== "string" || !isEffort(value.effort)) {
    return { ok: false, message: "Effort must be low, medium, high, xhigh, or max" };
  }
  // The chosen Worker Adapter's declared vocabulary is the truth (ADR 0042):
  // an effort answer it cannot honestly map would write a config Doctor
  // fails.
  const vocabulary = initEffortVocabulary(worker.worker);
  if (!vocabulary.includes(value.effort)) {
    return {
      ok: false,
      message: `effort is set but the ${worker.worker.kind} Worker Adapter does not map it. Remove effort or pick a Worker Adapter that maps it.`,
    };
  }
  return {
    ok: true,
    answers: { tracker: tracker.tracker, worker: worker.worker, model, effort: value.effort },
  };
}

// The Effort vocabulary of the Adapter a kind of Init Worker writes (ADR
// 0042): read from the declared constants the factories pass through, so
// Init never constructs a Worker Adapter just to inspect it. Only claude and
// opencode write Adapters that map Effort; the init.test.ts pin keeps these
// reads aligned with the factories' own declarations.
function initEffortVocabulary(worker: InitWorker): readonly Effort[] {
  if (worker.kind === "claude") {
    return standardEffortVocabulary;
  }
  if (worker.kind === "opencode") {
    return opencodeEffortVocabulary;
  }
  return [];
}

// The Adapter the answers name, for the questions only an Adapter can
// answer: the model question asks its `listModels` — the same factories the
// stub writes — while Effort keeps reading the declared constants above (the
// pin in init.test.ts keeps those aligned). Init holds no vendor facts of
// its own (ADR 0047).
function initWorkerAdapter(worker: InitWorker): WorkerAdapter {
  if (worker.kind === "cursor") {
    return cursor();
  }
  if (worker.kind === "claude") {
    return claude();
  }
  if (worker.kind === "opencode") {
    return opencode();
  }
  return custom({ bin: worker.bin, unattendedFlag: worker.unattendedFlag });
}

function linearSelector(tracker: Extract<InitTracker, { kind: "linear" }>): string {
  if (tracker.state !== undefined) {
    return `state: ${JSON.stringify(tracker.state)}`;
  }
  if (tracker.project !== undefined) {
    return `project: ${JSON.stringify(tracker.project)}`;
  }
  return `label: ${JSON.stringify(tracker.label)}`;
}

function trackerCall(tracker: InitTracker): string {
  if (tracker.kind === "github") {
    return `github({
    repo: ${JSON.stringify(tracker.repo)},
    ready: "unblocked",
    labels: ${JSON.stringify(tracker.labels)},
  })`;
  }
  return `linear({
    ready: "unblocked",
    ${linearSelector(tracker)},
  })`;
}

function workerCall(worker: InitWorker): string {
  if (worker.kind === "custom") {
    return `custom({
    bin: ${JSON.stringify(worker.bin)},
    unattendedFlag: ${JSON.stringify(worker.unattendedFlag)},
  })`;
  }
  return `${worker.kind}()`;
}

function configStub(answers: InitAnswers, contextFile: string | undefined): string {
  const settings = [
    `  tracker: ${trackerCall(answers.tracker)},`,
    `  worker: ${workerCall(answers.worker)},`,
    `  model: ${JSON.stringify(answers.model)},`,
    // A Run spawns print-mode, where ask cannot reach the Consumer (ADR 0027).
    `  permissions: "unattended",`,
  ];
  if (answers.effort !== undefined) {
    settings.push(`  effort: ${JSON.stringify(answers.effort)},`);
  }
  if (contextFile !== undefined) {
    settings.push(`  contextFile: ${JSON.stringify(contextFile)},`);
  }
  return `import { defineConfig, ${answers.tracker.kind}, ${answers.worker.kind} } from "@readyrun/readyrun";

export default defineConfig({
${settings.join("\n")}
});
`;
}

function required(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return "Required";
  }
  return undefined;
}

function unlessCancelled<T>(value: T | symbol): T | undefined {
  if (isCancel(value)) {
    cancel("Init cancelled.");
    return undefined;
  }
  return value;
}

export function configWrittenMessage(path: string): string {
  const href = pathToFileURL(resolve(path)).href;
  return `Wrote \u001b]8;;${href}\u001b\\readyrun.config.ts\u001b]8;;\u001b\\`;
}

async function collectInitAnswers(cwd: string): Promise<InitAnswers | undefined> {
  intro("ReadyRun");
  const trackerKind = unlessCancelled(
    await select({
      message: "Tracker",
      options: [
        { value: "github" as const, label: "GitHub" },
        { value: "linear" as const, label: "Linear" },
      ],
    }),
  );
  if (trackerKind === undefined) {
    return undefined;
  }
  const tracker = await collectTracker(trackerKind, cwd);
  if (tracker === undefined) {
    return undefined;
  }
  const worker = await collectWorker();
  if (worker === undefined) {
    return undefined;
  }
  const model = await collectModel(worker);
  if (model === undefined) {
    return undefined;
  }
  const effort = await collectEffort(worker);
  if (effort === "cancelled") {
    return undefined;
  }
  return { tracker, worker, model, effort };
}

async function collectTracker(
  kind: "github" | "linear",
  cwd: string,
): Promise<InitTracker | undefined> {
  if (kind === "github") {
    const suggested = await originRepository(cwd);
    const repo = unlessCancelled(
      await text({
        message: "GitHub repository",
        placeholder: "owner/name",
        initialValue: suggested,
        validate: required,
      }),
    );
    if (repo === undefined) {
      return undefined;
    }
    const labelsRaw = unlessCancelled(
      await text({
        message: "Frontier labels",
        placeholder: "ready-for-agent",
        initialValue: "ready-for-agent",
        validate: required,
      }),
    );
    if (labelsRaw === undefined) {
      return undefined;
    }
    const labels = labelsRaw.split(",").map((label) => label.trim()).filter(
      (label) => label.length > 0,
    );
    return { kind: "github", repo: repo.trim(), labels };
  }
  const selectorKind = unlessCancelled(
    await select({
      message: "Frontier selector",
      options: [
        { value: "label" as const, label: "Label" },
        { value: "state" as const, label: "State" },
        { value: "project" as const, label: "Project" },
      ],
    }),
  );
  if (selectorKind === undefined) {
    return undefined;
  }
  const value = unlessCancelled(
    await text({
      message: `Frontier ${selectorKind}`,
      validate: required,
    }),
  );
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (selectorKind === "state") {
    return { kind: "linear", state: trimmed };
  }
  if (selectorKind === "project") {
    return { kind: "linear", project: trimmed };
  }
  return { kind: "linear", label: trimmed };
}

async function collectWorker(): Promise<InitWorker | undefined> {
  const kind = unlessCancelled(
    await select({
      message: "Worker Adapter",
      options: [
        { value: "cursor" as const, label: "Cursor" },
        { value: "claude" as const, label: "Claude" },
        { value: "opencode" as const, label: "OpenCode" },
        { value: "custom" as const, label: "Custom binary" },
      ],
    }),
  );
  if (kind === undefined) {
    return undefined;
  }
  if (kind !== "custom") {
    return { kind };
  }
  const bin = unlessCancelled(
    await text({
      message: "Worker binary",
      validate: required,
    }),
  );
  if (bin === undefined) {
    return undefined;
  }
  const unattendedFlag = unlessCancelled(
    await text({
      message: "Unattended flag",
      placeholder: "--dangerously-skip-permissions",
      initialValue: "--dangerously-skip-permissions",
      validate: required,
    }),
  );
  if (unattendedFlag === undefined) {
    return undefined;
  }
  return { kind: "custom", bin: bin.trim(), unattendedFlag: unattendedFlag.trim() };
}

async function collectModel(worker: InitWorker): Promise<string | undefined> {
  // The Adapter answers with its own listing or catalog (ADR 0047); Init
  // renders whichever rows come back and never parses vendor output.
  const models = await listedModels(initWorkerAdapter(worker));
  if (models.length === 0) {
    // The fallback for a custom binary or an OpenCode CLI that is missing,
    // unauthed, or lists nothing (#160): today's typed prompt.
    const typed = unlessCancelled(
      await text({
        message: "Default model",
        placeholder: worker.kind === "opencode" ? "provider/model" : undefined,
        validate: required,
      }),
    );
    return typed?.trim();
  }
  const initial = models.find((model) => model.hint === "default")?.id ??
    models[0]?.id;
  const options = [
    ...models.map((model) => ({
      value: model.id,
      label: model.label,
      hint: model.hint === undefined ? model.id : `${model.id} · ${model.hint}`,
    })),
    { value: otherModel, label: "Other…" },
  ];
  const picked = unlessCancelled(
    models.length > 8
      ? await autocomplete({
        message: "Default model",
        options,
        initialValue: initial,
        placeholder: "Type to search…",
      })
      : await select({
        message: "Default model",
        options,
        initialValue: initial,
      }),
  );
  if (picked === undefined) {
    return undefined;
  }
  if (picked !== otherModel) {
    return picked;
  }
  const typed = unlessCancelled(
    await text({
      message: "Default model",
      validate: required,
    }),
  );
  return typed?.trim();
}

const workerDefaultEffort = "default";

// Only an Adapter that declares an Effort vocabulary is asked (ADR 0042):
// cursor takes Effort as a model variant, and custom maps none until it
// declares one — either answer would write a config the compile and Doctor
// both refuse.
async function collectEffort(
  worker: InitWorker,
): Promise<Effort | undefined | "cancelled"> {
  const vocabulary = initEffortVocabulary(worker);
  if (vocabulary.length === 0) {
    return undefined;
  }
  const picked = unlessCancelled(
    await select({
      message: "Effort",
      options: [
        { value: workerDefaultEffort, label: "Worker default" },
        ...vocabulary.map((value) => ({
          value,
          label: effortLabel(value),
        })),
      ],
      initialValue: "high",
    }),
  );
  if (picked === undefined) {
    return "cancelled";
  }
  if (picked === workerDefaultEffort) {
    return undefined;
  }
  if (!isEffort(picked)) {
    return undefined;
  }
  return picked;
}

const consumerContextFile = "GLOSSARY.md";

// Not a prompt: the file is either already at the Consumer root or it is not,
// the same shape as Init's .gitignore step (ADR 0026).
function contextFileAtRoot(cwd: string): string | undefined {
  return existsSync(resolve(cwd, consumerContextFile)) ? consumerContextFile : undefined;
}

/**
 * Write the Consumer's `readyrun.config.ts` stub and cover `.readyrun/` in
 * `.gitignore`. Interactive by default (Clack); scriptable with
 * `--answers <file>` or {@link InitOptions.answers} so CI or a
 * template-repo setup script can drive it without a TTY. The stub is one a
   * Run can use as-is: Permissions `"unattended"`, and `contextFile` pointed
   * at `GLOSSARY.md` when the Consumer root already holds one. It does not
 * assemble `run`.
 *
 * @returns 0 when the stub is written, 1 on a cancelled prompt.
 */
export async function init(options: InitOptions): Promise<number> {
  const prompted = options.answers === undefined;
  const answers = options.answers ?? await collectInitAnswers(options.cwd);
  if (answers === undefined) {
    return 1;
  }
  const path = resolve(options.cwd, "readyrun.config.ts");
  await writeFile(path, configStub(answers, contextFileAtRoot(options.cwd)));
  await ensureReadyrunGitignored(options.cwd);
  if (prompted) {
    outro(configWrittenMessage(path));
  }
  return 0;
}
