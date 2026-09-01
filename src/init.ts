import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  autocomplete,
  cancel,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";
import { originRepository } from "./git.ts";
import { isEffort, type Effort } from "./worker-adapter.ts";

const exec = promisify(execFile);
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
  | { kind: "custom"; bin: string; unattendedFlag: string };

export type InitAnswers = {
  tracker: InitTracker;
  worker: InitWorker;
  model: string;
  effort?: Effort;
};

export type InitOptions = {
  cwd: string;
  answers?: InitAnswers;
};

export type ListedModel = {
  id: string;
  label: string;
  hint?: string;
};

const fallbackCursorModels: ListedModel[] = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "composer-2", label: "Composer 2" },
  { id: "auto", label: "Auto" },
];

const claudeModels: ListedModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

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

function configStub(answers: InitAnswers): string {
  const effortLine = answers.effort === undefined
    ? ""
    : `\n  effort: ${JSON.stringify(answers.effort)},`;
  return `import { defineConfig, ${answers.tracker.kind}, ${answers.worker.kind} } from "@readyrun/readyrun";

export default defineConfig({
  tracker: ${trackerCall(answers.tracker)},
  worker: ${workerCall(answers.worker)},
  model: ${JSON.stringify(answers.model)},${effortLine}
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

const ansi = /\u001b\[[0-9;]*m/g;
const listedMarker = /\s*\((default|current)\)\s*$/i;

export function parseListedModels(stdout: string): ListedModel[] {
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ansi, "").trim();
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

export function configWrittenMessage(path: string): string {
  const href = pathToFileURL(resolve(path)).href;
  return `Wrote \u001b]8;;${href}\u001b\\readyrun.config.ts\u001b]8;;\u001b\\`;
}

async function listCursorModels(): Promise<ListedModel[]> {
  for (const bin of ["agent", "cursor-agent"]) {
    try {
      const { stdout } = await exec(bin, ["--list-models"], {
        encoding: "utf8",
        timeout: 4000,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TERM: "dumb",
        },
      });
      const models = parseListedModels(stdout);
      if (models.length > 0) {
        return models;
      }
    } catch {
      // Try the next binary, then the fallback catalog.
    }
  }
  return fallbackCursorModels;
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
  if (worker.kind === "custom") {
    const typed = unlessCancelled(
      await text({
        message: "Default model",
        validate: required,
      }),
    );
    return typed?.trim();
  }
  const models = worker.kind === "cursor"
    ? await listCursorModels()
    : claudeModels;
  if (models.length === 0) {
    const typed = unlessCancelled(
      await text({
        message: "Default model",
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

async function collectEffort(
  worker: InitWorker,
): Promise<Effort | undefined | "cancelled"> {
  if (worker.kind === "cursor") {
    return undefined;
  }
  const picked = unlessCancelled(
    await select({
      message: "Effort",
      options: [
        { value: workerDefaultEffort, label: "Worker default" },
        { value: "low" as const, label: "Low" },
        { value: "medium" as const, label: "Medium" },
        { value: "high" as const, label: "High" },
        { value: "xhigh" as const, label: "Extra high" },
        { value: "max" as const, label: "Max" },
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

const gitignoreEntry = ".readyrun/";

async function ensureGitignored(cwd: string): Promise<void> {
  const path = resolve(cwd, ".gitignore");
  await writeFile(path, `${gitignoreEntry}\n`);
}

export async function init(options: InitOptions): Promise<number> {
  const prompted = options.answers === undefined;
  const answers = options.answers ?? await collectInitAnswers(options.cwd);
  if (answers === undefined) {
    return 1;
  }
  const path = resolve(options.cwd, "readyrun.config.ts");
  await writeFile(path, configStub(answers));
  await ensureGitignored(options.cwd);
  if (prompted) {
    outro(configWrittenMessage(path));
  }
  return 0;
}
