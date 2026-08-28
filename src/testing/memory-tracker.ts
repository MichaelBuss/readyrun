import { createTrackerAdapter, type TrackerAdapter } from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";

export type MemoryTrackerOptions = {
  tickets: Ticket[];
  ready: "unblocked";
  labels: string[];
  parent?: string;
  ids?: string[];
};

export function memoryTracker(options: MemoryTrackerOptions): TrackerAdapter {
  const ineligible = new Set<string>();
  return createTrackerAdapter({
    frontier() {
      return Promise.resolve(
        options.tickets
          .filter((ticket) => {
            if (ineligible.has(ticket.id)) {
              return false;
            }
            if (!ticket.blockedBy.every((id) => ineligible.has(id))) {
              return false;
            }
            if (!options.labels.every((label) => ticket.labels.includes(label))) {
              return false;
            }
            if (options.parent !== undefined && ticket.parent !== options.parent) {
              return false;
            }
            if (options.ids !== undefined && !options.ids.includes(ticket.id)) {
              return false;
            }
            return true;
          })
          .sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true }),
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
    promptCopy(ticket) {
      return `This Ticket is ${ticket.id} on the in-memory Tracker.\nTitle: ${ticket.title}\n\n${ticket.body}\n\n${ticket.url}`;
    },
  });
}
