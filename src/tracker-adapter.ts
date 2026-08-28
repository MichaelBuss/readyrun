import type { Ticket } from "./ticket.ts";

const brand = Symbol("TrackerAdapter");

export type TrackerAdapter = {
  readonly [brand]: true;
  frontier(): Promise<Ticket[]>;
  branchName(ticket: Ticket): string;
  leaveFrontier(ticket: Ticket): Promise<void>;
  promptCopy(ticket: Ticket): string;
};

const defaults: Pick<
  TrackerAdapter,
  "frontier" | "branchName" | "leaveFrontier" | "promptCopy"
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
};

export function createTrackerAdapter(
  methods: Partial<
    Pick<TrackerAdapter, "frontier" | "branchName" | "leaveFrontier" | "promptCopy">
  > = {},
): TrackerAdapter {
  return { [brand]: true, ...defaults, ...methods };
}
