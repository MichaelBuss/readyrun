import type { Ticket } from "./ticket.ts";
import { assertKnownKeys } from "./unknown-keys.ts";

const brand = Symbol("TrackerAdapter");

const knownTrackerAdapterKeys = new Set([
  "frontier",
  "branchName",
  "leaveFrontier",
  "promptCopy",
  "inspect",
]);

export type TrackerInspect = {
  readonly existingLabels: readonly string[];
  readonly selectorLabels: readonly string[];
  readonly existingStates?: readonly string[];
  readonly selectorState?: string;
  readonly existingProjects?: readonly string[];
  readonly selectorProject?: string;
  readonly repository?: string;
  readonly canExpressBlocking: boolean;
};

// ADR 0016's optional root, named per Run on the command line (ADR 0038): a
// parent, whose children become the Frontier, or an explicit list of Tickets,
// which bypasses the Consumer selector but never `ready: "unblocked"`.
export type FrontierRoot =
  | { readonly kind: "parent"; readonly id: string }
  | { readonly kind: "list"; readonly ids: readonly string[] };

// Where a finished Ticket's work went. The Run Branch and the merge commit are
// the only durable pointers to it, since the Ticket's own Branch is deleted as
// it merges (ADR 0028), and a Ticket that names them says nothing a Tracker
// Adapter has to look up (ADR 0033).
export type Landing = {
  readonly runBranch: string;
  readonly mergeCommit: string;
};

export type TrackerAdapter = {
  readonly [brand]: true;
  frontier(root?: FrontierRoot): Promise<Ticket[]>;
  branchName(ticket: Ticket): string;
  leaveFrontier(ticket: Ticket, landing: Landing): Promise<void>;
  promptCopy(ticket: Ticket): string;
  inspect(): Promise<TrackerInspect>;
};

const defaults: Pick<
  TrackerAdapter,
  "frontier" | "branchName" | "leaveFrontier" | "promptCopy" | "inspect"
> = {
  // A root reaches the Adapter as an argument (ADR 0038), so an Adapter that
  // has not implemented it must refuse rather than answer as if none was
  // named — an empty answer would pass as a Frontier that is merely blocked.
  frontier(root) {
    if (root !== undefined) {
      return Promise.reject(
        new Error(
          "This Tracker Adapter does not honor a root; implement frontier(root) or name the Frontier with the selector alone.",
        ),
      );
    }
    return Promise.resolve([]);
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

export function createTrackerAdapter(
  methods: Partial<
    Pick<
      TrackerAdapter,
      "frontier" | "branchName" | "leaveFrontier" | "promptCopy" | "inspect"
    >
  > = {},
): TrackerAdapter {
  assertKnownKeys(methods, knownTrackerAdapterKeys);
  return { [brand]: true, ...defaults, ...methods };
}
