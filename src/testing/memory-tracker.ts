import { createTrackerAdapter, type TrackerAdapter } from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";

export type MemoryTrackerOptions = {
  tickets: Ticket[];
};

export function memoryTracker(options: MemoryTrackerOptions): TrackerAdapter {
  const ineligible = new Set<string>();
  return createTrackerAdapter({
    frontier() {
      return Promise.resolve(
        options.tickets.filter(
          (ticket) => ticket.blockedBy.length === 0 && !ineligible.has(ticket.id),
        ),
      );
    },
    branchName(ticket) {
      return `readyrun/${ticket.id}`;
    },
    leaveFrontier(ticket) {
      ineligible.add(ticket.id);
      return Promise.resolve();
    },
  });
}
