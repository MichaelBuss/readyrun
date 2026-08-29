import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";

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
};

export type InitOptions = {
  cwd: string;
  answers?: InitAnswers;
};

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
  return `import { defineConfig, ${answers.tracker.kind}, ${answers.worker.kind} } from "@readyrun/readyrun";

export default defineConfig({
  tracker: ${trackerCall(answers.tracker)},
  worker: ${workerCall(answers.worker)},
  model: ${JSON.stringify(answers.model)},
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

async function collectInitAnswers(): Promise<InitAnswers | undefined> {
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
  const tracker = await collectTracker(trackerKind);
  if (tracker === undefined) {
    return undefined;
  }
  const worker = await collectWorker();
  if (worker === undefined) {
    return undefined;
  }
  const model = unlessCancelled(
    await text({
      message: "Default model",
      placeholder: "composer-2",
      validate: required,
    }),
  );
  if (model === undefined) {
    return undefined;
  }
  return { tracker, worker, model: model.trim() };
}

async function collectTracker(
  kind: "github" | "linear",
): Promise<InitTracker | undefined> {
  if (kind === "github") {
    const repo = unlessCancelled(
      await text({
        message: "GitHub repository",
        placeholder: "owner/name",
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
      validate: required,
    }),
  );
  if (unattendedFlag === undefined) {
    return undefined;
  }
  return { kind: "custom", bin: bin.trim(), unattendedFlag: unattendedFlag.trim() };
}

export async function init(options: InitOptions): Promise<number> {
  const prompted = options.answers === undefined;
  const answers = options.answers ?? await collectInitAnswers();
  if (answers === undefined) {
    return 1;
  }
  await writeFile(join(options.cwd, "readyrun.config.ts"), configStub(answers));
  if (prompted) {
    outro("Wrote readyrun.config.ts");
  }
  return 0;
}
