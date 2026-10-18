import { shortCommit } from "./git.ts";
import type { ForgePort } from "./forge.ts";
import { assertKnownKeys } from "./unknown-keys.ts";
import type { Ticket } from "./ticket.ts";
import type { TrackerAdapter } from "./tracker-adapter.ts";

const brand = Symbol("DeliveryStrategy");

const knownDeliveryKeys = new Set(["name", "requiresForge", "describe"]);

/**
 * One Ticket merge of a Run Branch's settled history, as delivery reads it:
 * the Run wrote exactly one merge commit per Ticket (ADR 0028), and its
 * message names the Ticket — so Tracker identity is recoverable from the
 * history the Run already produced, without asking the Run anything.
 */
export type LandedTicket = {
  readonly id: string;
  readonly title: string;
  readonly mergeCommit: string;
};

/**
 * What a Delivery strategy reads before naming what it wants published:
 * the checkout, the Run Branch's settled history, the Tracker read, and the
 * forge when one is resolvable. Everything here is a read; producing any of
 * it is the deliver engine's, never the strategy's.
 */
export type DeliveryInput = {
  /** The Consumer root the delivery works from. */
  readonly cwd: string;
  /** The Run Branch the delivery renders over. */
  readonly runBranch: string;
  /** The Run Branch's tip commit. */
  readonly runBranchTip: string;
  /** The default branch, as the checkout resolves it. */
  readonly defaultBranch: string;
  /**
   * The commit below the whole range — contained in the default branch by
   * construction, and the honesty boundary for a range-PR's diff. None when
   * the Run Branch and the default branch share no history at all, which is
   * the divergence the `main` mode's fast-forward check refuses anyway.
   */
  readonly integratedBase: string | undefined;
  /**
   * The range's Ticket merges, oldest first. A merge commit the Run wrote
   * and no other: a first-parent commit that is not one of these is work
   * delivery did not collect, and range-PR strategies refuse it.
   */
  readonly merges: readonly LandedTicket[];
  /**
   * Every first-parent commit in the range, oldest first — Ticket merges
   * and anything else that reached the Run Branch. Strategies render over
   * merges; the rest is what makes a range-PR's diff a lie.
   */
  readonly range: readonly {
    readonly commit: string;
    readonly subject: string;
    readonly isTicketMerge: boolean;
  }[];
  readonly tracker: TrackerAdapter;
  /**
   * The forge port, when the Tracker names one deliver can drive (ADR 0048).
   * Undefined is forgeless, and forge-requiring strategies are refused
   * before `describe` runs.
   */
  readonly forge: ForgePort | undefined;
};

/**
 * What a strategy wants published, as desired state the engine reconciles —
 * never actions it performs. The head branch name *is* the artifact's
 * identity: `readyrun/deliver/<tracker-identity>`, so a retried delivery
 * finds its own half-done work by name (ADR 0048).
 */
export type Desired =
  | {
      kind: "pull-request";
      /** The head branch: the artifact's identity, derived from Tracker identity. */
      readonly head: string;
      /** The commit the head branch carries. */
      readonly commit: string;
      /** The base branch the pull request opens against. */
      readonly base: string;
      readonly title: string;
      readonly body: string;
    }
    | {
      kind: "fast-forward";
      /** The local ref to move; only the default branch is a built-in desire. */
      readonly ref: string;
      /** The commit the ref would fast-forward to. */
      readonly commit: string;
    };

/** What `describe` answers: the desired publications, plus what it saw that the Plan should say. */
export type DesiredAnswer = {
  readonly publications: readonly Desired[];
  /** Read-only observations the Plan discloses: a family still landing, and the like. */
  readonly notes?: readonly string[];
};

/**
 * A Delivery strategy: the policy that renders a Delivery over a Run
 * Branch's settled history (ADR 0048). It receives the reads and answers
 * desired state; the deliver engine holds the forge and the git, computes
 * the Plan, and reconciles. Built-ins ship as `family-pr`, `stack`, and
 * `main`; a Consumer authors one through {@link createDelivery}, sibling to
 * `createTrackerAdapter` (ADR 0025).
 */
export type DeliveryStrategy = {
  readonly [brand]: true;
  /** The name `--mode` resolves. */
  readonly name: string;
  /**
   * Whether the mode publishes forge artifacts: true makes the Delivery's
   * Doctor refuse a forgeless Tracker with that named cause (ADR 0048).
   */
  readonly requiresForge: boolean;
  /** The desired published state, computed read-only. Refusals throw. */
  describe(input: DeliveryInput): Promise<DesiredAnswer>;
};

/**
 * Build a Delivery strategy: name it, say whether it needs a forge, and
 * answer the publications you want. Unknown keys throw
 * {@link UnknownConfigKeyError}; the engine holds every write, so a strategy
 * cannot perform one.
 *
 * @param spec The strategy's name, forge need, and desired-state answer.
 */
export function createDelivery(spec: {
  name: string;
  requiresForge?: boolean;
  describe(input: DeliveryInput): Promise<DesiredAnswer>;
}): DeliveryStrategy {
  assertKnownKeys(spec, knownDeliveryKeys);
  if (spec.name.trim() === "") {
    throw new Error("A Delivery strategy must be named");
  }
  return {
    [brand]: true,
    name: spec.name,
    requiresForge: spec.requiresForge ?? false,
    describe: spec.describe,
  };
}

// The head-branch namespace delivery owns. The artifact *is* its head branch
// name (ADR 0048), derived from Tracker identity, so existence is checked by
// name and a retried delivery finds its own work.
export function deliverHeadName(identity: string): string {
  return `readyrun/deliver/${identity}`;
}

// The merge message the Run wrote (ADR 0028) is `Ticket <id>: <title>`; the
// same derivation reads it back, so delivery never needs the Run to have
// kept anything.
export function parseTicketMerge(
  subject: string,
  commit: string,
): LandedTicket | undefined {
  const match = /^Ticket ([^:]+): (.*)$/s.exec(subject);
  return match === null
    ? undefined
    : { id: match[1] ?? "", title: match[2] ?? "", mergeCommit: commit };
}

// The Closes footer (#154): the copy that closes Tickets lives in the
// delivery layer, on the PR body — never in a Tracker Adapter. Emitted only
// for the forge deliver can drive today (GitHub issues close by reference).
function closesFooter(ids: readonly string[]): string {
  return ids.map((id) => `Closes #${id}`).join("\n");
}

// The Landing facts every PR body carries, so the reviewer sees where the
// work came from without fetching anything.
function landingFacts(input: DeliveryInput, merges: readonly LandedTicket[]): string {
  return [
    `Landed on the Run Branch \`${input.runBranch}\`${
      input.integratedBase === undefined
        ? ""
        : `, cut from ${shortCommit(input.integratedBase)}`
    }:`,
    ...merges.map((merge) =>
      `- Ticket ${merge.id}: ${merge.title} (\`${shortCommit(merge.mergeCommit)}\`)`
    ),
  ].join("\n");
}

async function parentOf(
  tracker: TrackerAdapter,
  id: string,
): Promise<Ticket | undefined> {
  const [ticket] = await tracker.tickets([id]);
  return ticket;
}

/**
 * `family-pr`: when a parent's children have all landed, publish the
 * family's range as one PR titled after the parent (#126's instance). The
 * PR's diff must be exactly the family's work, so the strategy refuses —
 * with a named cause — when the family's merge commits are interleaved with
 * unrelated Tickets on the first-parent history, when a non-Ticket commit
 * sits inside the family's range, or when the commit below the family's
 * first merge is not already in the default branch (ADR 0048). Families
 * completed across continuation Runs compose: the range is read off the
 * first-parent chain, keyed on Tracker identity, never off one Run's memory.
 */
export const familyPr = createDelivery({
  name: "family-pr",
  requiresForge: true,
  async describe(input) {
    const publications: Desired[] = [];
    const notes: string[] = [];
    if (input.merges.length === 0) {
      return { publications };
    }
    // The landed Tickets' Tracker facts: which family each merge belongs to.
    // A Ticket that has left the Frontier answers — it is on the Tracker the
    // way a label-dropped GitHub issue is open (ADR 0048).
    const landed = await input.tracker.tickets(input.merges.map((m) => m.id));
    const parentByLandedId = new Map(
      landed.map((ticket) => [ticket.id, ticket.parent]),
    );
    const families = new Map<string, LandedTicket[]>();
    for (const merge of input.merges) {
      const parent = parentByLandedId.get(merge.id);
      // A standalone Ticket is no family: `family-pr` publishes parents'
      // ranges, and a parentless merge is simply not its input.
      if (parent === undefined) {
        continue;
      }
      const own = families.get(parent) ?? [];
      own.push(merge);
      families.set(parent, own);
    }
    for (const [parentId, family] of families) {
      const parent = await parentOf(input.tracker, parentId);
      if (parent === undefined) {
        throw new Error(
          `Ticket ${parentId}, the parent of landed Ticket ${family[0]?.id}, does not exist on the Tracker`,
        );
      }
      // Completeness is the Tracker's judgment: the parent's open children
      // still to land, whatever label they wear now. Any candidate still
      // means the family is landing, not landed.
      const tree = await input.tracker.tree({ kind: "parent", id: parentId });
      const unlanded = [...tree.frontier, ...tree.waiting];
      if (unlanded.length > 0) {
        notes.push(
          `family ${parentId} (${parent.title}) is still landing: ${unlanded.length} child${
            unlanded.length === 1 ? "" : "ren"
          } not landed (${unlanded.map((t) => t.id).join(", ")})`,
        );
        continue;
      }
      // The family's merges must be the whole range span from its first
      // merge to its last: interleaved unrelated merges, a non-Ticket commit
      // inside the span, or an unintegrated commit below the first merge
      // would all make the PR's diff carry work the family does not own —
      // the lie ADR 0048 refuses.
      const first = family[0];
      const last = family.at(-1);
      if (first === undefined || last === undefined) {
        continue;
      }
      const chain = input.range;
      const firstIndex = chain.findIndex(
        (entry) => entry.commit === first.mergeCommit,
      );
      const lastIndex = chain.findIndex(
        (entry) => entry.commit === last.mergeCommit,
      );
      const span = chain.slice(firstIndex, lastIndex + 1);
      const foreign = span.filter(
        (entry) =>
          !family.some((merge) => merge.mergeCommit === entry.commit) &&
          !entry.isTicketMerge,
      );
      if (foreign.length > 0) {
        throw new Error(
          `a commit that is not a Ticket merge (${shortCommit(foreign[0]!.commit)}, "${foreign[0]!.subject}") sits inside the family ${parentId} range on ${input.runBranch}; the pull request's diff would not be exactly the family's work`,
        );
      }
      const interleaved = span.filter(
        (entry) => !family.some((merge) => merge.mergeCommit === entry.commit),
      );
      if (interleaved.length > 0) {
        const foreignIds = input.merges
          .filter((m) =>
            interleaved.some((entry) => entry.commit === m.mergeCommit)
          )
          .map((m) => m.id);
        throw new Error(
          `Ticket${foreignIds.length === 1 ? "" : "s"} ${foreignIds.join(", ")} interleaved with the family ${parentId} range on ${input.runBranch}; the pull request's diff would not be exactly the family's work`,
        );
      }
      // The span's first merge must be the range's oldest commit: the commit
      // below it is the range's integrated boundary, so anything between it
      // and the family is unintegrated work the diff would carry.
      if (firstIndex !== 0 || lastIndex === -1) {
        throw new Error(
          `the commit below the family ${parentId}'s first merge on ${input.runBranch} is not in the default branch (${input.defaultBranch}); the pull request's diff would carry work the family does not own`,
        );
      }
      publications.push({
        kind: "pull-request",
        head: deliverHeadName(parentId),
        commit: last.mergeCommit,
        base: input.defaultBranch,
        title: `${parent.id}: ${parent.title}`,
        body: [
          `ReadyRun delivery: the family of Ticket ${parent.id} (${parent.title}) as one pull request.`,
          "",
          closesFooter([parent.id, ...family.map((merge) => merge.id)]),
          "",
          landingFacts(input, family),
        ].join("\n"),
      });
    }
    return { publications, notes };
  },
});

/**
 * `stack`: render the first-parent chain as one ref and one PR per merge
 * commit, each based on the previous (ADR 0048). GitHub retargets a stacked
 * PR when the branch below it merges, so the Consumer merging mid-stack is
 * the act the next delivery reconciles around — this mode never rewrites
 * history and never re-bases an open PR.
 */
export const stack = createDelivery({
  name: "stack",
  requiresForge: true,
  async describe(input) {
    const publications: Desired[] = [];
    let previous: string | undefined;
    const total = input.merges.length;
    // Oldest first, so each part's base is the part below it.
    for (const [index, merge] of input.merges.entries()) {
      const head = deliverHeadName(merge.id);
      const base = previous ?? input.defaultBranch;
      previous = head;
      publications.push({
        kind: "pull-request",
        head,
        commit: merge.mergeCommit,
        base,
        title: `${merge.id}: ${merge.title}`,
        body: [
          `ReadyRun delivery: part ${index + 1} of ${total} of the stack over \`${input.runBranch}\`.`,
          "",
          `Base: \`${base}\`${
            index === 0
              ? ` — the default branch (${input.defaultBranch})`
              : " — the part below; merging it retargets this one"
          }.`,
          "",
          closesFooter([merge.id]),
          "",
          landingFacts(input, [merge]),
        ].join("\n"),
      });
    }
    return { publications };
  },
});

/**
 * `main`: fast-forward the default branch to the Run Branch
 * (`git fetch . <branch>:<default>`), refusing when the primary checkout
 * sits on the default branch — the engine's Doctor rule (ADR 0048). Unlike
 * the PR modes it discloses rather than refuses on unintegrated history:
 * the Plan shows exactly what would move.
 */
export const main = createDelivery({
  name: "main",
  async describe(input) {
    return {
      publications: [
        {
          kind: "fast-forward",
          ref: input.defaultBranch,
          commit: input.runBranchTip,
        },
      ],
    };
  },
});

/**
 * The built-in modes, by the names `--mode` resolves. Registry and strategy
 * stay one table, so a mode's name and its availability cannot drift.
 */
export const deliveryModes: Readonly<Record<string, DeliveryStrategy>> = {
  [familyPr.name]: familyPr,
  [stack.name]: stack,
  [main.name]: main,
};

/**
 * Resolve `--mode` to a strategy: a built-in, or one registered through
 * `defineConfig`'s `deliveries`. A registered strategy shadowing a built-in
 * name is refused — the built-ins' names are the flag surface's vocabulary.
 */
export function resolveDeliveryMode(
  name: string,
  registered: readonly DeliveryStrategy[] = [],
): DeliveryStrategy | undefined {
  const builtin = deliveryModes[name];
  const shadowing = registered.find((strategy) => strategy.name === name);
  if (builtin !== undefined && shadowing !== undefined) {
    throw new Error(
      `a registered Delivery strategy shadows the built-in mode "${name}"; rename it`,
    );
  }
  return builtin ?? shadowing;
}
