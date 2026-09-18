import {
  createTrackerAdapter,
  optionalRoot,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";

export type MemoryTrackerOptions = {
  tickets: Ticket[];
  ready: "unblocked";
  labels: string[];
  parent?: string;
  ids?: string[];
  existingLabels?: string[];
  canExpressBlocking?: boolean;
};

export function memoryTracker(options: MemoryTrackerOptions): TrackerAdapter {
  const ineligible = new Set<string>();
  const known = new Set(options.tickets.map((ticket) => ticket.id));
  return createTrackerAdapter({
    frontier(root) {
      // A root named on the call replaces the selector's root (ADR 0038).
      const effective = root ?? optionalRoot(options.parent, options.ids);
      if (effective?.kind === "list") {
        for (const id of effective.ids) {
          if (!known.has(id)) {
            return Promise.reject(
              new Error(`Ticket ${id} does not exist on the Tracker`),
            );
          }
        }
      }
      if (effective?.kind === "parent" && !known.has(effective.id)) {
        return Promise.reject(
          new Error(`Ticket ${effective.id} does not exist on the Tracker`),
        );
      }
      return Promise.resolve(
        options.tickets
          .filter((ticket) => {
            if (ineligible.has(ticket.id)) {
              return false;
            }
            if (!ticket.blockedBy.every((id) => ineligible.has(id))) {
              return false;
            }
            if (effective?.kind === "list") {
              return effective.ids.includes(ticket.id);
            }
            if (!options.labels.every((label) => ticket.labels.includes(label))) {
              return false;
            }
            if (effective?.kind === "parent" && ticket.parent !== effective.id) {
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
    inspect() {
      const existingLabels = options.existingLabels ?? [
        ...new Set([
          ...options.labels,
          ...options.tickets.flatMap((ticket) => ticket.labels),
        ]),
      ];
      return Promise.resolve({
        existingLabels,
        selectorLabels: options.labels,
        canExpressBlocking: options.canExpressBlocking ?? true,
      });
    },
  });
}
