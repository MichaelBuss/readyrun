import {
  cancel,
  confirm,
  groupMultiselect,
  intro,
  outro,
  select,
  text,
  type SelectOptions,
} from "@clack/prompts";
import { defineConfig, type ReadyRunConfig } from "./config.ts";
import {
  ConfigNotFoundError,
  configLoadFailure,
  loadConfig,
} from "./consumer-config.ts";
import {
  headContainsCommit,
  headRunBranchTrap,
  listRunBranches,
  resolveRunBase,
  type ListedRunBranch,
} from "./git.ts";
import { init as initEntry, type InitOptions } from "./init.ts";
import { computePlan, renderPlan, type Plan } from "./plan.ts";
import { run as runEntry, type RunOptions } from "./run.ts";
import { parseTicketRef } from "./frontier-root.ts";
import type { Ticket } from "./ticket.ts";
import {
  optionalRoot,
  type FrontierRoot,
  type TreeAnswer,
} from "./tracker-adapter.ts";
import { effortLabel, type Effort, type Permissions } from "./worker-adapter.ts";

// The Launcher's only terminal surface. The flow below talks to this shape,
// so the whole assembly is testable with scripted answers; the default
// implementation forwards to Clack, the dependency Init already uses
// (ADR 0040).
export type LauncherIO = {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  text(options: {
    message: string;
    initialValue?: string;
    validate?(value: string | undefined): string | undefined;
  }): Promise<string | symbol>;
  select<T extends string>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T | symbol>;
  confirm(options: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean | symbol>;
  // The tree question's multi-select across one rendering (ADR 0041): the
  // groups carry the tree — a parent per group, the parent node itself never
  // selectable — and the answer is the picked Ticket ids in the order the
  // rendering listed them.
  multiSelect(options: {
    message: string;
    groups: TreeGroup[];
    initialValues?: string[];
  }): Promise<string[] | symbol>;
};

const clackLauncherIO: LauncherIO = {
  intro: (message) => {
    intro(message);
  },
  outro: (message) => {
    outro(message);
  },
  cancel: (message) => {
    cancel(message);
  },
  text: async (options) => await text(options),
  select: async <T extends string>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }) => await select<T>(options as SelectOptions<T>),
  confirm: async (options) =>
    await confirm({
      message: options.message,
      initialValue: options.initialValue,
    }),
  multiSelect: (options) =>
    // The picks are Ticket ids, so string is what Clack answers.
    groupMultiselect<string>({
      message: options.message,
      options: Object.fromEntries(
        options.groups.map((group) => [group.label, group.options]),
      ) as Record<string, TreeOption[]>,
      initialValues: options.initialValues,
      // A Clack multi-select submits at least one row: the top choice is the
      // floor, so an accidental empty submit never reads as "take everything".
      required: true,
      // The group headers are the parents, and a parent is never worked.
      selectableGroups: false,
    }),
};

// The cap suggestion is the Plan's unblocked Frontier size (ADR 0040),
// floored at an explicit list's length, because a list whose cap is below
// its own length is a slice nobody asked for. At least 1: a Run cannot start
// with a cap of zero.
export function capSuggestion(
  frontierSize: number,
  root: RunOptions["root"],
): number {
  const floor = root?.kind === "list" ? root.ids.length : 0;
  return Math.max(frontierSize, floor, 1);
}

// Every answer the Launcher collects is flag-expressible (ADR 0040); the cap
// is the one that must parse before the Run can price it.
export function capAnswer(
  value: string | undefined,
): { ok: true; cap: number } | { ok: false; message: string } {
  const cap = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isInteger(cap) || cap < 1) {
    return { ok: false, message: "Cap must be a whole number of at least 1" };
  }
  return { ok: true, cap };
}

// The multi-select value that takes the rootless Frontier in pick order: it
// names no Root at all, so the Run works whatever the Tracker offers next
// (ADR 0041).
export const goFromTop = "__top__";

// What the tree question resolves to: the rootless Frontier, or the explicit
// `--ticket` list the picks emit (flag-expressibility, ADR 0040).
export type TreeChoice = { kind: "frontier" } | { kind: "list"; ids: string[] };

// One pickable row of the tree question's rendering.
export type TreeOption = { value: string; label: string; hint?: string };

// The rendering's group: one parent's children under a header that is itself
// never selectable, because a parent is never worked.
export type TreeGroup = { label: string; options: TreeOption[] };

// The blocked-status copy shared by the tree's hints and the waiting confirm.
function waitsOn(ticket: Ticket): string {
  return `waits on ${ticket.blockedBy.join(", ") || "an unknown blocker"}`;
}

// The tree the tree question renders in one look (ADR 0041): a first group
// holding the "go from the top" choice, then the Tree's candidates grouped
// under each parent — parents in first-appearance order over the pickable-now
// half, then the waiting half — each group listing its pickable-now Tickets
// before its waiting ones, both in pick order. A waiting Ticket carries its
// blockers in the hint.
export function treeGroups(answer: TreeAnswer): TreeGroup[] {
  const waiting = new Set(answer.waiting.map((ticket) => ticket.id));
  const option = (ticket: Ticket): TreeOption => ({
    value: ticket.id,
    label: ticket.title,
    hint: waiting.has(ticket.id)
      ? `${waitsOn(ticket)} — joins when it clears`
      : undefined,
  });
  const groups = new Map<string, TreeGroup>();
  const groupFor = (ticket: Ticket): TreeGroup => {
    const key = ticket.parent ?? "";
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        label: key === "" ? "No parent" : `Ticket ${key}`,
        options: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const ticket of answer.frontier) {
    groupFor(ticket).options.push(option(ticket));
  }
  for (const ticket of answer.waiting) {
    groupFor(ticket).options.push(option(ticket));
  }
  return [
    {
      label: "From the top",
      options: [
        {
          value: goFromTop,
          label: "Go from the top",
          hint: "the rootless Frontier in pick order — no --ticket list",
        },
      ],
    },
    ...groups.values(),
  ];
}

// The picked ids emitted in the order the tree rendered them, top to bottom —
// command-line order is not pick order, so the explicit list mirrors the one
// rendering it came from. The "go from the top" choice is not a Ticket id: a
// selection of it alone (or an empty one) is the rootless Frontier, while
// with Tickets also picked the list wins — the more specific answer.
export function treePick(
  selected: readonly string[],
  answer: TreeAnswer,
): TreeChoice {
  const ids = treeGroups(answer)
    .flatMap((group) => group.options)
    .map((option) => option.value)
    .filter((id) => id !== goFromTop && selected.includes(id));
  return ids.length > 0 ? { kind: "list", ids } : { kind: "frontier" };
}

// The HEAD-state logic the Run Branch base picker answers (ADR 0040): parked
// on a Run Branch the default branch does not contain, steer to --base from
// the default branch; standing on a checkout that lacks the newest Run
// Branch's work, offer the picker; already containing it, a fresh Run with
// nothing to continue. Only unmerged Run Branches are ever offered — a merged
// one holds nothing left to review — and the picker lists Run Branches,
// never Worktrees (ADR 0029).
export type HeadBaseState =
  | { kind: "fresh" }
  | {
    kind: "steer";
    branch: string;
    defaultBranch: string;
    unmerged: ListedRunBranch[];
  }
  | { kind: "pick"; unmerged: ListedRunBranch[] };

export async function headBaseState(cwd: string): Promise<HeadBaseState> {
  const branches = await listRunBranches(cwd);
  const unmerged = branches.filter((branch) => !branch.mergedIntoDefault);
  const base = await resolveRunBase(cwd);
  const trap = await headRunBranchTrap(cwd, base);
  if (trap !== undefined) {
    return {
      kind: "steer",
      branch: trap.branch,
      defaultBranch: trap.defaultBranch,
      unmerged,
    };
  }
  const newest = unmerged[0];
  if (newest === undefined || await headContainsCommit(cwd, newest.tip)) {
    return { kind: "fresh" };
  }
  return { kind: "pick", unmerged };
}

// An answer kept at its config default carries no flag: the flags-only
// invocation of the same answers omits it, so the Plan's equivalent command
// shows exactly what differs.
const keptDefault = Symbol("kept-default");

type Collected<T> = { value: T } | typeof keptDefault;

export type LauncherOptions = {
  cwd?: string;
  stdout?: { write(chunk: string): unknown };
  loadConfig?: (cwd: string) => Promise<ReadyRunConfig>;
  run?: (options: RunOptions) => Promise<number>;
  init?: (options: InitOptions) => Promise<number>;
  io?: LauncherIO;
};

// The plan the Launcher renders before its confirm — the same Plan
// `run --preview` renders, under a header that says a Run will start.
const launcherPlanHeader = "Plan for this Run\n";

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function launcher(options: LauncherOptions = {}): Promise<number> {
  const io = options.io ?? clackLauncherIO;
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  const load = options.loadConfig ?? loadConfig;
  let config: ReadyRunConfig;
  let greeted = false;
  try {
    config = await load(cwd);
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError)) {
      stdout.write(`${configLoadFailure(error)}\n`);
      return 1;
    }
    greeted = true;
    io.intro("ReadyRun");
    const offered = await io.confirm({
      message: "No ReadyRun config found. Run init?",
      initialValue: true,
    });
    if (typeof offered === "symbol" || !offered) {
      io.cancel("Init cancelled.");
      return 1;
    }
    const exit = await (options.init ?? initEntry)({ cwd });
    if (exit !== 0) {
      return exit;
    }
    try {
      config = await load(cwd);
    } catch (error) {
      io.cancel("Init did not leave a usable config.");
      stdout.write(`${configLoadFailure(error)}\n`);
      return 1;
    }
    // The Init hand-off's gate (ADR 0043): Init was the reason for this
    // invocation, so Run assembly asks before starting instead of walking
    // the maintainer through five answers to say "not now". A decline is
    // the config ready and a success, not a failed Run.
    const proceed = await io.confirm({
      message: "Config created. Start a Run now?",
      initialValue: true,
    });
    if (typeof proceed === "symbol") {
      io.cancel("Launcher cancelled.");
      return 1;
    }
    if (!proceed) {
      io.outro("Config ready — launch again when you want a Run.");
      return 0;
    }
  }
  if (!greeted) {
    io.intro("ReadyRun");
  }
  const resolved = defineConfig(config);
  // The tree question goes first (ADR 0041): the cap suggestion depends on
  // the selection, and the candidate tree is what the maintainer sat down to
  // see.
  let answer: TreeAnswer | undefined;
  let treeRefusal: string | undefined;
  try {
    answer = await resolved.tracker.tree(undefined);
  } catch (error) {
    treeRefusal = caughtMessage(error);
  }
  let root: FrontierRoot | undefined;
  let frontierSize: number;
  if (answer !== undefined) {
    const picked = await collectFromTree(io, answer);
    if (picked === undefined) {
      io.cancel("Launcher cancelled.");
      return 1;
    }
    root = picked.kind === "list" ? { kind: "list", ids: picked.ids } : undefined;
    frontierSize = answer.frontier.length;
  } else {
    // A refusal narrows the rendering, never what can be assembled (ADR 0041):
    // the same root flags continue as text prompts.
    stdout.write(
      `The Tracker Adapter does not answer the tree (${treeRefusal}); the root flags continue as prompts.\n`,
    );
    const fallback = await collectRootFallback(io);
    if (fallback === undefined) {
      io.cancel("Launcher cancelled.");
      return 1;
    }
    root = fallback;
    try {
      // The suggestion is the Plan's unblocked Frontier size, and the Plan's
      // Frontier is the named root's — the tree path's answer.frontier is the
      // same call for the rootless case.
      frontierSize = (await resolved.tracker.frontier(root)).length;
    } catch (error) {
      io.cancel(`Could not read the Frontier: ${caughtMessage(error)}`);
      return 1;
    }
  }
  const cap = await collectCap(io, frontierSize, root);
  if (cap === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const permissions = await collectPermissions(io, resolved);
  if (permissions === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const model = await collectModel(io, resolved);
  if (model === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  // The Adapter's declared Effort vocabulary is the truth the question may
  // offer (ADR 0042): without both a flag to map the answer and a
  // vocabulary declaring what exists — Cursor takes Effort as a model
  // variant — any effort answer would fail Doctor, so the question is not
  // asked; the same skip Init makes for cursor and custom.
  const effortVocabulary: readonly Effort[] = resolved.worker.effortVocabulary ?? [];
  const effort = resolved.worker.effortFlag === undefined ||
      effortVocabulary.length === 0
    ? keptDefault
    : await collectEffort(io, resolved, effortVocabulary);
  if (effort === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  let state: HeadBaseState;
  try {
    state = await headBaseState(cwd);
  } catch (error) {
    // A checkout git cannot answer for — no commit yet, or no repository —
    // has no HEAD state to read and nothing to assemble a Run on.
    io.cancel(`Could not read the checkout's HEAD state: ${caughtMessage(error)}`);
    return 1;
  }
  const base = await collectBase(io, state);
  if (base === undefined) {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  const runOptions: RunOptions = {
    config: resolved,
    cap: cap.value,
    base: base.base,
    root,
    cwd,
    stdout,
    permissions: permissions === keptDefault ? undefined : permissions.value,
    model: model === keptDefault ? undefined : model.value,
    effort: effort === keptDefault ? undefined : effort.value,
  };
  let plan: Plan;
  try {
    plan = await computePlan(runOptions);
  } catch (error) {
    io.cancel(`Could not resolve the Plan: ${caughtMessage(error)}`);
    return 1;
  }
  await renderPlan(stdout, plan, cwd, launcherPlanHeader);
  const start = await io.confirm({
    message: "Start this Run?",
    initialValue: true,
  });
  if (typeof start === "symbol") {
    io.cancel("Launcher cancelled.");
    return 1;
  }
  if (!start) {
    io.outro("Run not started.");
    return 1;
  }
  // On confirm the Launcher exits its own UI; the Run's ADR 0035 renderer
  // owns the terminal from here (ADR 0040). Nothing above created anything:
  // every read was Plan work, so a Ctrl-C leaves no half-created Run.
  io.outro("Starting the Run");
  return await (options.run ?? runEntry)(runOptions);
}

// The Effort option value that means "leave it to the config and the
// Worker": never an Effort itself, so a kept default and a picked effort
// cannot collide.
export const defaultEffort = "__default__";

async function collectCap(
  io: LauncherIO,
  frontierSize: number,
  root: FrontierRoot | undefined,
): Promise<{ value: number } | undefined> {
  const answer = await io.text({
    message: "Cap — the most Tickets this Run may start",
    initialValue: String(capSuggestion(frontierSize, root)),
    validate: (value) => {
      const parsed = capAnswer(value);
      return parsed.ok ? undefined : parsed.message;
    },
  });
  if (typeof answer === "symbol") {
    return undefined;
  }
  const parsed = capAnswer(answer);
  return parsed.ok ? { value: parsed.cap } : undefined;
}

// The one confirm a selection with waiting Tickets owes (ADR 0041): asked
// once, when the selection ends, never per pick — refusing waiting Tickets
// would make the Launcher stricter than the flags it mirrors.
function waitingConfirmMessage(picked: readonly Ticket[]): string {
  const clauses = picked.map((ticket) => `#${ticket.id} ${waitsOn(ticket)}`);
  return picked.length === 1
    ? `${clauses[0]} — joins when it clears. Include it in this Run?`
    : `${picked.length} picked Tickets are waiting: ${clauses.join("; ")} — they join when their blockers clear. Include them?`;
}

// The tree question: one multi-select across the one rendering, then the
// single waiting confirm. Declining every picked waiting Ticket dissolves the
// selection, so the tree question is asked again rather than silently
// widening to the rootless Frontier. An undefined return is a cancelled
// prompt.
async function collectFromTree(
  io: LauncherIO,
  answer: TreeAnswer,
): Promise<TreeChoice | undefined> {
  for (;;) {
    const picked = await io.multiSelect({
      message: "Which Tickets should this Run work?",
      groups: treeGroups(answer),
      initialValues: [goFromTop],
    });
    if (typeof picked === "symbol") {
      return undefined;
    }
    const choice = treePick(picked, answer);
    if (choice.kind === "frontier") {
      return choice;
    }
    const waiting = answer.waiting.filter((ticket) =>
      choice.ids.includes(ticket.id)
    );
    if (waiting.length === 0) {
      return choice;
    }
    const keep = await io.confirm({
      message: waitingConfirmMessage(waiting),
      initialValue: true,
    });
    if (typeof keep === "symbol") {
      return undefined;
    }
    if (keep) {
      return choice;
    }
    const kept = choice.ids.filter((id) => !waiting.some((t) => t.id === id));
    if (kept.length > 0) {
      return { kind: "list", ids: kept };
    }
  }
}

// The tree's fallback (ADR 0041): the same flags an Adapter refusal narrows
// the rendering to, as text prompts. An undefined return is a cancelled
// prompt; the explicit list wins over the parent, as only one root names a
// Frontier.
async function collectRootFallback(
  io: LauncherIO,
): Promise<FrontierRoot | undefined> {
  const parent = await io.text({
    message:
      "Root — a parent Ticket id; its children become the Frontier (empty for none)",
  });
  if (typeof parent === "symbol") {
    return undefined;
  }
  const tickets = await io.text({
    message:
      "Tickets — ids or URLs, separated by commas or spaces (empty for none)",
  });
  if (typeof tickets === "symbol") {
    return undefined;
  }
  const ids = tickets
    .split(/[,\s]+/)
    .filter((ref) => ref.length > 0)
    .map(parseTicketRef);
  const trimmedParent = parent.trim();
  return optionalRoot(
    trimmedParent === "" ? undefined : parseTicketRef(trimmedParent),
    ids.length > 0 ? ids : undefined,
  );
}

async function collectPermissions(
  io: LauncherIO,
  config: ReadyRunConfig,
): Promise<Collected<Permissions> | undefined> {
  const picked = await io.select<Permissions>({
    message: "Permissions",
    initialValue: config.permissions,
    options: [
      { value: "ask", label: "Ask", hint: "the Worker asks before acting" },
      {
        value: "unattended",
        label: "Unattended",
        hint: "the Worker acts without asking",
      },
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  return picked === config.permissions ? keptDefault : { value: picked };
}

async function collectModel(
  io: LauncherIO,
  config: ReadyRunConfig,
): Promise<Collected<string> | undefined> {
  const answer = await io.text({
    message: "Model",
    initialValue: config.model,
    validate: (value) =>
      value === undefined || value.trim() === "" ? "Required" : undefined,
  });
  if (typeof answer === "symbol") {
    return undefined;
  }
  const trimmed = answer.trim();
  return trimmed === config.model ? keptDefault : { value: trimmed };
}

async function collectEffort(
  io: LauncherIO,
  config: ReadyRunConfig,
  vocabulary: readonly Effort[],
): Promise<Collected<Effort> | undefined> {
  const picked = await io.select<Effort | typeof defaultEffort>({
    message: "Effort",
    initialValue: config.effort ?? defaultEffort,
    options: [
      {
        value: defaultEffort,
        label: config.effort === undefined
          ? "Worker default"
          : `Config default (${config.effort})`,
      },
      // Exactly the values the Adapter declares (ADR 0042): nothing that
      // does not exist can be selected.
      ...vocabulary.map((value) => ({ value, label: effortLabel(value) })),
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  if (picked === defaultEffort || picked === config.effort) {
    return keptDefault;
  }
  return { value: picked };
}

const freshRun = "__fresh__";

// The picked base; `base: undefined` is a real answer (a fresh Run names no
// --base), while the undefined return is a cancelled prompt.
type BaseAnswer = { base: string | undefined };

async function collectBase(
  io: LauncherIO,
  state: HeadBaseState,
): Promise<BaseAnswer | undefined> {
  if (state.kind === "fresh") {
    return { base: undefined };
  }
  if (state.kind === "steer") {
    const picked = await io.select<string>({
      message: `HEAD is the Run Branch ${state.branch}, which the default branch (${state.defaultBranch}) does not contain — start this Run from the default branch`,
      initialValue: state.defaultBranch,
      options: [
        {
          value: state.defaultBranch,
          label: state.defaultBranch,
          hint: "start from the default branch",
        },
        ...state.unmerged.map((branch) => ({
          value: branch.name,
          label: branch.name,
          hint: "continue this Run Branch",
        })),
      ],
    });
    if (typeof picked === "symbol") {
      return undefined;
    }
    return { base: picked };
  }
  const picked = await io.select<string | typeof freshRun>({
    message: "Base for this Run",
    initialValue: state.unmerged[0]?.name,
    options: [
      ...state.unmerged.map((branch) => ({
        value: branch.name,
        label: branch.name,
        hint: "continue this Run Branch",
      })),
      { value: freshRun, label: "Fresh Run from HEAD", hint: "no --base" },
    ],
  });
  if (typeof picked === "symbol") {
    return undefined;
  }
  return { base: picked === freshRun ? undefined : picked };
}
