import {
  createTrackerAdapter,
  optionalRoot,
  type FrontierRoot,
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
  /**
   * The forge fact `inspect()` answers, as a forge-backed Tracker Adapter
   * would (ADR 0048); absent is forgeless.
   */
  forge?: string;
};

export function memoryTracker(options: MemoryTrackerOptions): TrackerAdapter {
  const ineligible = new Set<string>();
  const known = new Set(options.tickets.map((ticket) => ticket.id));
  // A root named on the call replaces the selector's root (ADR 0038); a
  // nonexistent named Ticket is refused, as `frontier` refuses one.
  function refuseUnknownRoot(root: FrontierRoot | undefined): Error | undefined {
    if (root?.kind === "list") {
      for (const id of root.ids) {
        if (!known.has(id)) {
          return new Error(`Ticket ${id} does not exist on the Tracker`);
        }
      }
    }
    if (root?.kind === "parent" && !known.has(root.id)) {
      return new Error(`Ticket ${root.id} does not exist on the Tracker`);
    }
    return undefined;
  }
  // The root and selector decide candidacy; the caller decides which side of
  // the Frontier a candidate sits on (unblocked, or waiting on a blocker).
  function candidates(root: FrontierRoot | undefined): Ticket[] {
    const effective = root ?? optionalRoot(options.parent, options.ids);
    const refusal = refuseUnknownRoot(effective);
    if (refusal !== undefined) {
      throw refusal;
    }
    return options.tickets.filter((ticket) => {
      if (ineligible.has(ticket.id)) {
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
    });
  }
  const pickOrder = (tickets: Ticket[]): Ticket[] =>
    [...tickets].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
  // A Tracker that cannot express blocking has no honest waiting or tree
  // answer: it refuses, as the shipped Adapters do, rather than answer from
  // `blockedBy` facts it could not know. `frontier` is untouched: it shipped
  // answering, and Doctor is the authority that refuses a Tracker like this.
  function refuseWhenBlockingUnexpressable(): void {
    if (options.canExpressBlocking === false) {
      throw new Error(
        "This Tracker cannot express blocking, so no waiting or tree answer exists. Pick a Tracker Adapter that can.",
      );
    }
  }
  const unblocked = (ticket: Ticket): boolean =>
    ticket.blockedBy.every((id) => ineligible.has(id));
  return createTrackerAdapter({
    async frontier(root) {
      return pickOrder(candidates(root).filter(unblocked));
    },
    async waiting(root) {
      refuseWhenBlockingUnexpressable();
      return pickOrder(candidates(root).filter((ticket) => !unblocked(ticket)));
    },
    async tree(root) {
      refuseWhenBlockingUnexpressable();
      const all = candidates(root);
      const effective = root ?? optionalRoot(options.parent, options.ids);
      return {
        parent: effective?.kind === "parent"
          ? options.tickets.find((ticket) => ticket.id === effective.id)
          : undefined,
        frontier: pickOrder(all.filter(unblocked)),
        waiting: pickOrder(all.filter((ticket) => !unblocked(ticket))),
      };
    },
    leaveFrontier(ticket) {
      ineligible.add(ticket.id);
      return Promise.resolve();
    },
    tickets(ids) {
      const refused = ids.find((id) => !known.has(id));
      if (refused !== undefined) {
        return Promise.reject(
          new Error(`Ticket ${refused} does not exist on the Tracker`),
        );
      }
      // Left-Frontier Tickets answer here: they are on the Tracker the way a
      // label-dropped GitHub issue is open, and delivery reads them for the
      // facts — parent among them — the Frontier never needs again (ADR 0048).
      return Promise.resolve(
        ids.flatMap((id) => {
          const found = options.tickets.find((ticket) => ticket.id === id);
          return found === undefined ? [] : [found];
        }),
      );
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
        ...(options.forge === undefined ? {} : { forge: options.forge }),
      });
    },
  });
}
