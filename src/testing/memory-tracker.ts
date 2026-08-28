import { createTrackerAdapter, type TrackerAdapter } from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";

export type MemoryTrackerOptions = {
  tickets: Ticket[];
};

export function memoryTracker(options: MemoryTrackerOptions): TrackerAdapter {
  return Object.assign(createTrackerAdapter(), { tickets: options.tickets });
}
