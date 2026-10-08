import type { Ticket } from "./ticket.ts";
import { assertKnownKeys } from "./unknown-keys.ts";

const brand = Symbol("TrackerAdapter");

const knownTrackerAdapterKeys = new Set([
  "frontier",
  "waiting",
  "tree",
  "branchName",
  "leaveFrontier",
  "promptCopy",
  "inspect",
]);

/**
 * What a Tracker Adapter tells Doctor about the Tracker it talks to: what
 * exists there, what the Frontier selector names, and whether blocking can
 * be expressed at all. Doctor lies-check the selector against it.
 */
export type TrackerInspect = {
  /** The labels that exist on the Tracker. */
  readonly existingLabels: readonly string[];
  /** The labels the Frontier selector names; each must exist. */
  readonly selectorLabels: readonly string[];
  /** The states that exist, for Trackers with states (Linear). */
  readonly existingStates?: readonly string[];
  /** The state the Frontier selector names, when it names one. */
  readonly selectorState?: string;
  /** The projects that exist, for Trackers with projects (Linear). */
  readonly existingProjects?: readonly string[];
  /** The project the Frontier selector names, when it names one. */
  readonly selectorProject?: string;
  /** The repository the Adapter is pointed at, when the Tracker has one. */
  readonly repository?: string;
  /** Whether the Tracker can express blocking; `false` is a Doctor failure. */
  readonly canExpressBlocking: boolean;
};

/**
 * ADR 0016's optional root, named per Run on the command line (ADR 0038): a
 * parent, whose children become the Frontier, or an explicit list of Tickets,
 * which bypasses the Consumer selector but never `ready: "unblocked"`.
 */
export type FrontierRoot =
  | { readonly kind: "parent"; readonly id: string }
  | { readonly kind: "list"; readonly ids: readonly string[] };

// The root a Tracker Adapter's own options stand in with when a Run names
// none on the call (ADR 0038): the explicit list wins over the parent, as
// only one root names a Frontier.
export function optionalRoot(
  parent: string | undefined,
  ids: string[] | undefined,
): FrontierRoot | undefined {
  if (ids !== undefined) {
    return { kind: "list", ids };
  }
  if (parent !== undefined) {
    return { kind: "parent", id: parent };
  }
  return undefined;
}

/**
 * Where a finished Ticket's work went. The Run Branch and the merge commit are
 * the only durable pointers to it, since the Ticket's own Branch is deleted as
 * it merges (ADR 0028), and a Ticket that names them says nothing a Tracker
 * Adapter has to look up (ADR 0033).
 */
export type Landing = {
  readonly runBranch: string;
  readonly mergeCommit: string;
};

/**
 * The Tracker-specific implementation that maps that Tracker's work onto a
 * Ticket: the Frontier, the waiting Tickets, the tree, the Branch name, the
 * prompt copy, and where a finished Ticket goes. v0 ships {@link github} and
 * {@linkcode linear}; a Consumer building one for a Tracker this package
 * does not ship (Jira, GitLab) calls {@link createTrackerAdapter} directly —
 * the same building block the shipped factories use internally.
 */
export type TrackerAdapter = {
  readonly [brand]: true;
  /** The Frontier: the Tickets the loop may pick from next, in pick order. */
  frontier(root?: FrontierRoot): Promise<Ticket[]>;
  /**
   * The Tickets that match the Frontier's selector and root but wait off it,
   * each carrying its blockers on `blockedBy` (ADR 0039). With `frontier()`
   * it partitions the root's candidates; it never mutates the Tracker.
   * Answered in stable pick order. With no root it answers for the
   * selector's candidates — a Tracker that cannot enumerate them refuses.
   * An Adapter refuses — rather than answer empty, which would read as
   * "nothing waits" — when blocking cannot be expressed or a named root is
   * a lie.
   */
  waiting(root?: FrontierRoot): Promise<Ticket[]>;
  /**
   * The parent/children facts a tree rendering needs, in one read-only look
   * at the same root flags `frontier` takes (ADR 0039): the parent root's own
   * Ticket as the tree's root node — a parent is never worked — and the
   * root's open candidates split into the Frontier half and the waiting half,
   * each Ticket carrying its `parent` and `blockedBy`. The halves are the
   * same answers `frontier(root)` and `waiting(root)` give and partition the
   * root's candidates; with no root, the selector's. An Adapter that cannot
   * answer it — blocking not expressible, a root it does not honor, a lie,
   * or candidates it cannot enumerate — refuses, never answers empty.
   */
  tree(root?: FrontierRoot): Promise<TreeAnswer>;
  /** The Branch name a Worker's Ticket works on: `readyrun/<id>` by default. */
  branchName(ticket: Ticket): string;
  /** Where a finished Ticket goes when it leaves the Frontier. */
  leaveFrontier(ticket: Ticket, landing: Landing): Promise<void>;
  /** The Adapter's own copy of the Ticket, as the Worker prompt names it. */
  promptCopy(ticket: Ticket): string;
  /** What the Adapter's Tracker actually has, for Doctor to lie-check against. */
  inspect(): Promise<TrackerInspect>;
};

/**
 * The answer `tree()` owes: who roots the tree, and its open candidates as
 * the two halves every renderer needs — pickable now, and waiting on what.
 */
export type TreeAnswer = {
  readonly parent: Ticket | undefined;
  readonly frontier: readonly Ticket[];
  readonly waiting: readonly Ticket[];
};

const defaults: Pick<
  TrackerAdapter,
  | "frontier"
  | "waiting"
  | "tree"
  | "branchName"
  | "leaveFrontier"
  | "promptCopy"
  | "inspect"
> = {
  // A root reaches the Adapter as an argument (ADR 0038), so an Adapter that
  // has not implemented it must refuse rather than answer as if none was
  // named — an empty answer would pass as a Frontier that is merely blocked.
  frontier(root) {
    if (root !== undefined) {
      return Promise.reject(
        new Error(
          "This Tracker Adapter does not honor a root, so a rooted Run cannot start. Drop the root flags or pick a Tracker Adapter that names a root.",
        ),
      );
    }
    return Promise.resolve([]);
  },
  // Waiting Tickets are answered by Tracker Adapters that compute them; one
  // that has not must refuse rather than answer empty, which would read as
  // "nothing waits" (ADR 0039).
  waiting() {
    return Promise.reject(
      new Error(
        "This Tracker Adapter does not answer waiting Tickets. Pick a Tracker Adapter that does.",
      ),
    );
  },
  // The tree is answered by Tracker Adapters that compute it; one that has
  // not must refuse rather than answer empty, which would read as a Tracker
  // with no parent, no Frontier, and nothing waiting (ADR 0039).
  tree() {
    return Promise.reject(
      new Error(
        "This Tracker Adapter does not answer the tree. Pick a Tracker Adapter that does.",
      ),
    );
  },
  branchName(ticket) {
    return `readyrun/${ticket.id}`;
  },
  leaveFrontier() {
    return Promise.resolve();
  },
  promptCopy(ticket) {
    return `Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.body}\n\n${ticket.url}`;
  },
  inspect() {
    return Promise.resolve({
      existingLabels: [],
      selectorLabels: [],
      canExpressBlocking: true,
    });
  },
};

/**
 * Build a Tracker Adapter for a Tracker this package does not ship (Jira,
 * GitLab): the defaults answer `branchName`, `promptCopy`, `leaveFrontier`,
 * and `inspect`; you supply what your Tracker owes — at minimum `frontier`.
 * Unknown method names throw {@link UnknownConfigKeyError}; methods you omit
 * refuse rather than answer empty.
 *
 * @param methods The surface your Tracker answers; everything else keeps its default.
 */
export function createTrackerAdapter(
  methods: Partial<
    Pick<
      TrackerAdapter,
      | "frontier"
      | "waiting"
      | "tree"
      | "branchName"
      | "leaveFrontier"
      | "promptCopy"
      | "inspect"
    >
  > = {},
): TrackerAdapter {
  assertKnownKeys(methods, knownTrackerAdapterKeys);
  return { [brand]: true, ...defaults, ...methods };
}
