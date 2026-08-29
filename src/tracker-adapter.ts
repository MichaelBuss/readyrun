import type { Ticket } from "./ticket.ts";

const brand = Symbol("TrackerAdapter");

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

export type TrackerAdapter = {
  readonly [brand]: true;
  frontier(): Promise<Ticket[]>;
  branchName(ticket: Ticket): string;
  leaveFrontier(ticket: Ticket): Promise<void>;
  promptCopy(ticket: Ticket): string;
  inspect(): Promise<TrackerInspect>;
};

const defaults: Pick<
  TrackerAdapter,
  "frontier" | "branchName" | "leaveFrontier" | "promptCopy" | "inspect"
> = {
  frontier() {
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
  return { [brand]: true, ...defaults, ...methods };
}
