import type { Ticket } from "./ticket.ts";

const brand = Symbol("TrackerAdapter");

export type TrackerAdapter = {
  readonly [brand]: true;
  frontier(): Promise<Ticket[]>;
  branchName(ticket: Ticket): string;
  leaveFrontier(ticket: Ticket): Promise<void>;
};

export function createTrackerAdapter(
  methods: Pick<TrackerAdapter, "frontier" | "branchName" | "leaveFrontier"> = {
    frontier() {
      return Promise.resolve([]);
    },
    branchName(ticket) {
      return `readyrun/${ticket.id}`;
    },
    leaveFrontier() {
      return Promise.resolve();
    },
  },
): TrackerAdapter {
  return { [brand]: true, ...methods };
}
