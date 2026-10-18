import { defineConfig, type ReadyRunConfig } from "./config.ts";
import {
  deliveryModes,
  parseTicketMerge,
  resolveDeliveryMode,
  type Desired,
  type DesiredAnswer,
  type DeliveryInput,
  type DeliveryStrategy,
  type LandedTicket,
} from "./delivery.ts";
import { resolveForge, type ForgePort, type ForgePullRequest } from "./forge.ts";
import {
  defaultBranchOf,
  fastForwardRef,
  firstParentRange,
  firstRefTip,
  headBranch,
  isAncestor,
  localBranchTip,
  mergeBase,
  originRepository,
  pushRefToOrigin,
  remoteRefTips,
  shortCommit,
} from "./git.ts";

type DeliverStdout = { write(chunk: string): unknown };

/**
 * What `readyrun deliver` takes: the Consumer's config (its Tracker read and
 * its registered Delivery strategies), the mode and Run Branch — both
 * explicit, never guessed — and the pull-request creation options, which are
 * birth options applied once and never revisited (ADR 0048). The flag
 * surface `readyrun deliver` parses maps one-to-one onto these.
 */
export type DeliverInput = {
  config: ReadyRunConfig;
  /** The Delivery mode: a built-in or a registered strategy's name. */
  mode: string;
  /** The Run Branch to render over. */
  branch: string;
  /** The Consumer root. Defaults to the process's working directory. */
  cwd?: string;
  /** Where the Delivery's lines are written. Defaults to process stdout. */
  stdout?: DeliverStdout;
  /** Birth option for pull-request modes: create the PRs as drafts. */
  draft?: boolean;
  /** Birth option for pull-request modes: label the PRs at creation. */
  labels?: readonly string[];
  /**
   * The forge to drive, injected. Defaults to the one the Tracker's forge
   * fact resolves (ADR 0048); tests and embedders script their own.
   */
  forge?: ForgePort;
};

/**
 * What the reconcile loop takes beyond the Plan it consumes: where it works
 * and where its lines are written, the same shape the Run's runtime keeps.
 */
export type DeliverRuntime = {
  config: ReadyRunConfig;
  cwd: string;
  stdout: DeliverStdout;
};

/** One pull-request publication, priced against what the remote already has. */
export type PublicationPlan = {
  desired: Extract<Desired, { kind: "pull-request" }>;
  /** Ref existence by name is the reconcile key (ADR 0048). */
  refState: "missing" | "present" | "moved";
  remoteTip?: string;
  /** The open PR found by head branch, when the forge answered. */
  pullRequest?: ForgePullRequest;
  /** What blocked pricing this publication; a refusal the perform never crosses. */
  problem?: string;
};

/** One fast-forward desire, priced against where the local ref stands. */
export type FastForwardPlan = {
  desired: Extract<Desired, { kind: "fast-forward" }>;
  current?: string;
  state: "would-move" | "already-there" | "refuses";
  problem?: string;
};

/**
 * Everything a Delivery resolves before its first side effect (ADR 0048):
 * Doctor's verdict, the strategy's notes, the birth options, and every
 * publication priced against the world as it stands. Computed once, rendered
 * read-only; the reconcile consumes it, so a retried delivery re-prices
 * rather than remembers.
 */
export type DeliveryPlan = {
  doctorFailures: string[];
  mode: string;
  branch: string;
  command: string;
  /** Birth options, as the Plan rendered them. */
  creation: { draft: boolean; labels: readonly string[] };
  /** The forge the publications are priced and performed against. */
  forge?: ForgePort;
  /** The Run Branch holds no history the default branch lacks. */
  empty: boolean;
  notes: readonly string[];
  publications: PublicationPlan[];
  fastForwards: FastForwardPlan[];
  /** The squash-merge caveat (ADR 0048), when the repository allows squash. */
  squashWarning: boolean;
};

// The merge commits delivery reads are the ones the Run wrote (ADR 0028); a
// first-parent commit that parses as none is work delivery did not collect,
// and range-PR strategies price their honesty against it. The range arrives
// oldest first, the order strategies render in.
function readMerges(
  range: Awaited<ReturnType<typeof firstParentRange>>,
): { merges: LandedTicket[]; isTicketMerge: Set<string> } {
  const merges: LandedTicket[] = [];
  const isTicketMerge = new Set<string>();
  for (const entry of range) {
    const merge = parseTicketMerge(entry.subject, entry.commit);
    if (merge !== undefined && entry.parents >= 2) {
      merges.push(merge);
      isTicketMerge.add(entry.commit);
    }
  }
  return { merges, isTicketMerge };
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the Delivery's Plan (ADR 0048): Doctor's verdict — mode known, Run
 * Branch present, remote and forge where the mode publishes, the checkout
 * off the default branch for `main` — then the strategy's desired state,
 * priced against the remote's refs and the forge's open pull requests.
 * Read-only end to end: nothing is pushed, nothing opens, nothing moves.
 */
export async function computeDeliveryPlan(
  options: DeliverInput,
): Promise<DeliveryPlan> {
  const config = defineConfig(options.config);
  const cwd = options.cwd ?? process.cwd();
  const failures: string[] = [];
  const notes: string[] = [];

  let strategy: DeliveryStrategy | undefined;
  try {
    strategy = resolveDeliveryMode(options.mode, config.deliveries ?? []);
  } catch (error) {
    failures.push(describeFailure(error));
  }
  if (strategy === undefined) {
    failures.push(
      `mode "${options.mode}" is not a built-in (${
        Object.keys(deliveryModes).join(", ")
      }) and names no registered Delivery strategy`,
    );
  }
  const draftOrLabels = options.draft === true ||
    (options.labels !== undefined && options.labels.length > 0);
  if (strategy !== undefined && !strategy.requiresForge && draftOrLabels) {
    failures.push(
      `--draft and --label are pull-request creation options, and mode ${strategy.name} publishes none`,
    );
  }
  const branchTip = await localBranchTip(cwd, options.branch);
  if (branchTip === undefined) {
    failures.push(
      `Run Branch ${options.branch} does not exist in this checkout`,
    );
  }
  const defaultBranch = await defaultBranchOf(cwd);
  const forge = options.forge ?? await resolveForge(cwd, config.tracker);
  if (strategy?.requiresForge === true) {
    if ((await originRepository(cwd)) === undefined) {
      failures.push(
        "this checkout has no origin remote, and a pull-request mode would push nowhere",
      );
    }
    if (forge === undefined) {
      failures.push(
        `mode ${strategy.name} publishes pull requests, and the Tracker Adapter declares no forge deliver can drive`,
      );
    }
  }
  if (strategy?.name === "main") {
    const on = await headBranch(cwd);
    if (on === defaultBranch) {
      failures.push(
        `the primary checkout sits on ${defaultBranch}, so the default branch cannot be fetched forward. Move the checkout off ${defaultBranch} first.`,
      );
    }
  }

  const plan: DeliveryPlan = {
    doctorFailures: failures,
    mode: options.mode,
    branch: options.branch,
    command: equivalentDeliverCommand(options),
    creation: { draft: options.draft === true, labels: options.labels ?? [] },
    forge,
    empty: false,
    notes,
    publications: [],
    fastForwards: [],
    squashWarning: false,
  };
  if (failures.length > 0 || strategy === undefined || branchTip === undefined) {
    return plan;
  }

  // The range is measured against origin's tracking ref of the default
  // branch first, because that is what a pull request's diff is computed
  // against; a checkout with no such ref measures against the local branch.
  const contained = await firstRefTip(cwd, [
    `refs/remotes/origin/${defaultBranch}`,
    `refs/heads/${defaultBranch}`,
  ]);
  const range = contained === undefined
    ? []
    : await firstParentRange(cwd, options.branch, contained.tip);
  if (range.length === 0) {
    plan.empty = true;
    return plan;
  }
  // rev-list answers newest first; strategies render oldest first, from the
  // range's base upward.
  const oldestFirst = [...range].reverse();
  const { merges, isTicketMerge } = readMerges(oldestFirst);
  const input: DeliveryInput = {
    cwd,
    runBranch: options.branch,
    runBranchTip: branchTip,
    defaultBranch,
    integratedBase: await integratedBaseOf(cwd, options.branch, defaultBranch),
    merges,
    range: oldestFirst.map((entry) => ({
      commit: entry.commit,
      subject: entry.subject,
      isTicketMerge: isTicketMerge.has(entry.commit),
    })),
    tracker: config.tracker,
    forge,
  };
  let answer: DesiredAnswer;
  try {
    answer = await strategy.describe(input);
  } catch (error) {
    plan.doctorFailures.push(describeFailure(error));
    return plan;
  }
  notes.push(...(answer.notes ?? []));

  const pulls = answer.publications.filter(
    (desired): desired is Extract<Desired, { kind: "pull-request" }> =>
      desired.kind === "pull-request",
  );
  const forwards = answer.publications.filter(
    (desired): desired is Extract<Desired, { kind: "fast-forward" }> =>
      desired.kind === "fast-forward",
  );

  // One ls-remote prices every head by name (ADR 0048), and one read per
  // head prices the forge's open PRs — existence by head branch, the exact
  // key the reconcile writes.
  const remoteTips = pulls.length > 0 && forge !== undefined
    ? await remoteRefTips(cwd, pulls.map((desired) => desired.head))
    : new Map<string, string>();
  for (const desired of pulls) {
    const remoteTip = remoteTips.get(desired.head);
    const priced: PublicationPlan = {
      desired,
      refState:
        remoteTip === undefined
          ? "missing"
          : remoteTip === desired.commit
          ? "present"
          : "moved",
      remoteTip,
    };
    if (forge !== undefined) {
      try {
        priced.pullRequest = await forge.findPullRequest(desired.head);
      } catch (error) {
        priced.problem = describeFailure(error);
      }
    }
    plan.publications.push(priced);
  }
  for (const desired of forwards) {
    const current = await localBranchTip(cwd, desired.ref);
    const priced: FastForwardPlan = {
      desired,
      current,
      state: "would-move",
    };
    if (current === undefined) {
      priced.state = "refuses";
      priced.problem = `the ${desired.ref} ref does not exist in this checkout`;
    } else if (current === desired.commit) {
      priced.state = "already-there";
    } else if (await isAncestor(cwd, current, desired.commit)) {
      priced.state = "would-move";
    } else {
      priced.state = "refuses";
      priced.problem = `moving ${desired.ref} to ${
        shortCommit(desired.commit)
      } would not be a fast-forward`;
    }
    plan.fastForwards.push(priced);
  }

  // The squash caveat (ADR 0048) is warn-only, and only where it bites: a
  // publication whose base is another publication's head.
  const chained = plan.publications.some((mine) =>
    plan.publications.some((other) => other.desired.head === mine.desired.base)
  );
  if (chained && forge !== undefined) {
    try {
      plan.squashWarning = (await forge.mergeMethods()).includes("squash");
    } catch {
      // A probe that fails warns nothing; it never refuses.
    }
  }
  return plan;
}

// The common ancestor of the Run Branch and the default branch — the
// boundary a range-PR's diff hangs from. None when they share no history at
// all, which is the divergence the `main` mode's fast-forward check refuses.
async function integratedBaseOf(
  cwd: string,
  branch: string,
  defaultBranch: string,
): Promise<string | undefined> {
  try {
    return await mergeBase(cwd, branch, defaultBranch);
  } catch {
    return undefined;
  }
}

// The exact equivalent `readyrun deliver …` command, so the flag surface is
// learned by reading the Plan rather than by failing a delivery.
export function equivalentDeliverCommand(options: DeliverInput): string {  const parts = [
    "readyrun",
    "deliver",
    "--mode",
    options.mode,
    "--branch",
    options.branch,
  ];
  if (options.draft === true) {
    parts.push("--draft");
  }
  for (const label of options.labels ?? []) {
    parts.push("--label", label);
  }
  return parts.join(" ");
}

/**
 * Render the Delivery's Plan read-only, under whatever header the surface
 * names. Same split as the Run's Plan: Doctor's verdict first, then what
 * would be pushed, which PRs opened, and on which bases (ADR 0048).
 * `deliver --preview` renders it under the preview's header; the Launcher
 * renders the same Plan under its own before the delivery it confirmed
 * publishes.
 */
export function renderDeliveryPlan(
  stdout: DeliverStdout,
  plan: DeliveryPlan,
  header = "Delivery preview: nothing is published; this Plan is read-only\n",
): void {
  stdout.write(header);
  if (plan.doctorFailures.length === 0) {
    stdout.write("Doctor: pass\n");
  } else {
    for (const failure of plan.doctorFailures) {
      stdout.write(`Doctor: ${failure}\n`);
    }
  }
  stdout.write(`Mode: ${plan.mode} over ${plan.branch}\n`);
  for (const note of plan.notes) {
    stdout.write(`Note: ${note}\n`);
  }
  if (plan.empty) {
    stdout.write(
      "Range: empty — the Run Branch holds no history the default branch lacks\n",
    );
  }
  for (const publication of plan.publications) {
    const { desired } = publication;
    stdout.write(
      `Publication: ${desired.head} at ${
        shortCommit(desired.commit)
      } → ${desired.base}\n`,
    );
    if (publication.problem !== undefined) {
      stdout.write(`  Would refuse: ${publication.problem}\n`);
      continue;
    }
    if (publication.refState === "moved") {
      stdout.write(
        `  Would refuse: the remote ref is at ${
          shortCommit(publication.remoteTip ?? "")
        }, not this delivery's commit; rewriting is never delivery's\n`,
      );
      continue;
    }
    if (publication.pullRequest !== undefined) {
      stdout.write(
        `  Already published: PR #${publication.pullRequest.number} ${publication.pullRequest.url}\n`,
      );
      continue;
    }
    stdout.write(
      publication.refState === "missing"
        ? "  Would push the ref, then open the pull request\n"
        : "  The ref is already pushed; would open the pull request\n",
    );
  }
  for (const forward of plan.fastForwards) {
    const { desired } = forward;
    if (forward.state === "already-there") {
      stdout.write(
        `Fast-forward: ${desired.ref} is already at ${
          shortCommit(desired.commit)
        }\n`,
      );
      continue;
    }
    stdout.write(
      `Fast-forward: ${desired.ref} → ${shortCommit(desired.commit)}${
        forward.state === "refuses" && forward.problem !== undefined
          ? `\n  Would refuse: ${forward.problem}`
          : ""
      }\n`,
    );
  }
  if (plan.squashWarning) {
    stdout.write(
      "Warning: this repository allows squash merges; squash-merging a lower pull request in a stack duplicates the upper one's diff until it is rebased\n",
    );
  }
  stdout.write(`Deliver with: ${plan.command}\n`);
}

function writeDoctorFailures(
  stdout: DeliverStdout,
  failures: readonly string[],
): 0 | 1 {
  if (failures.length === 0) {
    return 0;
  }
  for (const failure of failures) {
    stdout.write(`Doctor: ${failure}\n`);
  }
  return 1;
}

/**
 * The Delivery's reconcile loop, consuming a resolved Plan: the Plan's
 * pricing is the whole truth, so a priced problem refuses before any side
 * effect, and each clean publication is performed only as the Plan priced
 * it — push the missing ref, open the missing PR, move the fast-forward.
 * A retried delivery re-prices and finishes its own half-done work by name
 * (ADR 0048).
 *
 * @returns 0 for a delivered or empty delivery, 1 for a refusal or a failure.
 */
export async function deliverPlan(
  plan: DeliveryPlan,
  runtime: DeliverRuntime,
): Promise<number> {
  const cwd = runtime.cwd;
  const stdout = runtime.stdout;
  if (writeDoctorFailures(stdout, plan.doctorFailures) === 1) {
    return 1;
  }
  if (plan.empty) {
    stdout.write(
      `Delivery: ${plan.branch} holds no history the default branch lacks; nothing to deliver.\n`,
    );
    return 0;
  }
  // A priced problem refuses the whole delivery before its first side
  // effect: reconcile renders the world, it never half-renders it.
  for (const publication of plan.publications) {
    if (publication.problem !== undefined) {
      stdout.write(
        `Deliver stopped: ${publication.desired.head} — ${publication.problem}\n`,
      );
      return 1;
    }
    if (publication.refState === "moved") {
      stdout.write(
        `Deliver stopped: the remote ref ${publication.desired.head} is at ${
          shortCommit(publication.remoteTip ?? "")
        }, not this delivery's commit (${
          shortCommit(publication.desired.commit)
        }); rewriting is never delivery's\n`,
      );
      return 1;
    }
  }
  for (const forward of plan.fastForwards) {
    if (forward.state === "refuses") {
      stdout.write(
        `Deliver stopped: ${
          forward.problem ?? `${forward.desired.ref} cannot fast-forward`
        }\n`,
      );
      return 1;
    }
  }
  const forge = plan.forge;
  if (plan.publications.length > 0 && forge === undefined) {
    stdout.write(
      "Deliver stopped: no forge to open pull requests with\n",
    );
    return 1;
  }

  const report = (line: string) => stdout.write(`${line}\n`);
  let opened = 0;
  let pushed = 0;
  let moved = 0;
  let published = 0;
  for (const publication of plan.publications) {
    const { desired } = publication;
    if (publication.refState === "missing") {
      try {
        await pushRefToOrigin(cwd, desired.head, desired.commit);
      } catch (error) {
        report(
          `Deliver stopped: could not push ${desired.head}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
      pushed += 1;
      report(`Pushed ${desired.head} at ${shortCommit(desired.commit)}`);
    }
    if (publication.pullRequest === undefined) {
      try {
        const created = await forge!.createPullRequest({
          head: desired.head,
          base: desired.base,
          title: desired.title,
          body: desired.body,
          draft: plan.creation.draft,
          labels: plan.creation.labels,
        });
        opened += 1;
        report(`Opened PR #${created.number}: ${created.url}`);
      } catch (error) {
        report(
          `Deliver stopped: could not open ${desired.head}'s pull request: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
    } else {
      published += 1;
      report(
        `Already published: PR #${publication.pullRequest.number} ${publication.pullRequest.url}`,
      );
    }
  }
  for (const forward of plan.fastForwards) {
    if (forward.state === "already-there") {
      report(
        `Already there: ${forward.desired.ref} is at ${shortCommit(forward.desired.commit)}`,
      );
      continue;
    }
    try {
      await fastForwardRef(cwd, plan.branch, forward.desired.ref);
    } catch (error) {
      report(
        `Deliver stopped: could not fast-forward ${forward.desired.ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
    moved += 1;
    report(
      `Fast-forwarded ${forward.desired.ref} to ${shortCommit(forward.desired.commit)}`,
    );
  }
  const performed = opened + pushed + moved;
  report(
    performed === 0
      ? "Delivery complete: nothing to publish."
      : `Delivery complete: ${
        [
          `${opened} pull request${opened === 1 ? "" : "s"} opened`,
          `${pushed} ref${pushed === 1 ? "" : "s"} pushed`,
          moved > 0
            ? `${moved} ref${moved === 1 ? "" : "s"} fast-forwarded`
            : undefined,
          published > 0 ? `${published} already published` : undefined,
        ].filter((count) => count !== undefined).join(", ")
      }.`,
  );
  return 0;
}

/**
 * One invocation of the Delivery: `readyrun deliver` and the library surface
 * for it. It computes the Plan — Doctor's verdict and every publication
 * priced — then hands it to {@link deliverPlan}.
 *
 * @returns 0 for a delivered or empty delivery, 1 for a refusal or a failure.
 */
export async function deliver(options: DeliverInput): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const plan = await computeDeliveryPlan({ ...options, cwd, stdout });
  return deliverPlan(plan, {
    config: options.config,
    cwd,
    stdout,
  });
}

/**
 * `deliver --preview`: the Plan rendered and nothing else. A Doctor verdict
 * with failures still renders the whole Plan; the exit code says the
 * delivery it previews would be refused.
 *
 * @returns 0 when the delivery would proceed, 1 when Doctor would refuse it.
 */
export async function previewDelivery(options: DeliverInput): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  const plan = await computeDeliveryPlan({ ...options, cwd, stdout });
  renderDeliveryPlan(stdout, plan);
  return plan.doctorFailures.length === 0 ? 0 : 1;
}
