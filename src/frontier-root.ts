import type { LivenessStdout } from "./liveness.ts";
import type { Ticket } from "./ticket.ts";
import type { FrontierRoot } from "./tracker-adapter.ts";

// `--ticket` accepts a bare id or a URL naming the Ticket: the last path
// segment is the id a Tracker Adapter knows.
export function parseTicketRef(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const segments = new URL(trimmed).pathname.split("/").filter((
    segment,
  ) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

function withinRoot(ticket: Ticket, root: FrontierRoot): boolean {
  return root.kind === "list"
    ? root.ids.includes(ticket.id)
    : ticket.parent === root.id;
}

// An Adapter's rooted answer is verified to lie within the root (ADR 0038), so
// an Adapter that silently ignores a root is caught and refused.
export function rootViolationMessages(
  tickets: readonly Ticket[],
  root: FrontierRoot,
): string[] {
  return tickets
    .filter((ticket) => !withinRoot(ticket, root))
    .map((ticket) =>
      `Ticket ${ticket.id} is not in the named root (${describeRoot(root)}); the Tracker Adapter ignored the root`
    );
}

// Named Tickets missing from the answer are waiting work, not lies (ADR 0038):
// they warn and join mid-Run when their blocker clears. A parent names no
// waiting Tickets, because a blocked child never reaches the answer.
export function waitingNamedIds(
  tickets: readonly Ticket[],
  root: FrontierRoot,
): string[] {
  if (root.kind !== "list") {
    return [];
  }
  const present = new Set(tickets.map((ticket) => ticket.id));
  return root.ids.filter((id) => !present.has(id));
}

export function describeRoot(root: FrontierRoot): string {
  return root.kind === "parent"
    ? `--root ${root.id}`
    : `--ticket ${root.ids.join(" ")}`;
}

export function warnWaitingRootTickets(
  stdout: LivenessStdout,
  root: FrontierRoot,
  tickets: readonly Ticket[],
): void {
  for (const id of waitingNamedIds(tickets, root)) {
    stdout.write(
      `Warning: Ticket ${id} is waiting work; it joins the Frontier when its blocker clears\n`,
    );
  }
  if (root.kind === "parent" && tickets.length === 0) {
    stdout.write(
      `Warning: no unblocked children under ${describeRoot(root)}\n`,
    );
  }
}
