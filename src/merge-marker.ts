import { parseTicketMerge } from "./delivery.ts";
import { firstParentSubjects, shortCommit } from "./git.ts";
import type { Ticket } from "./ticket.ts";

/**
 * One Frontier Ticket the Tracker calls unblocked whose blocker's merge
 * marker the resolved base does not contain (ADR 0050). A fact about the
 * marker, never about the work: the walk reads first-parent subjects in the
 * one `Ticket <id>:` grammar every ReadyRun merge carries, so a marker found
 * is work found, and a marker absent is a question — integration through a
 * squash, a family Delivery pull request, or a hand merge that rewrote
 * messages preserves the work but not the marker.
 */
export type MarkerGap = {
  /** The Frontier Ticket the Tracker reports unblocked. */
  readonly ticketId: string;
  /** The blocker that left the Frontier without its marker on the base. */
  readonly blockerId: string;
  /** The resolved base the walk measured, as the full commit it resolved to. */
  readonly base: string;
};

/**
 * The merge markers one base's first-parent history carries, read with the
 * grammar delivery's parser reads — one reader of one history (ADR 0049,
 * ADR 0050). Throws when git cannot answer; the caller decides the silence.
 */
async function mergeMarkersOnBase(
  cwd: string,
  base: string,
): Promise<Set<string>> {
  const subjects = await firstParentSubjects(cwd, base);
  const markers = new Set<string>();
  for (const subject of subjects) {
    const landed = parseTicketMerge(subject, "");
    if (landed !== undefined) {
      markers.add(landed.id);
    }
  }
  return markers;
}

/**
 * The disclosure's computation, once with the Plan (ADR 0039, ADR 0050):
 * for each Frontier Ticket, the blockers that have left the Frontier whose
 * `Ticket <id>:` merge marker the resolved base's first-parent history does
 * not carry. Best-effort end to end — a base whose history git cannot walk
 * answers no gaps rather than a failure, the way an outage never blocks
 * (ADR 0046); a Tracker Adapter that answers no left-Frontier blockers walks
 * nothing at all.
 */
export async function markerGaps(
  cwd: string,
  base: string,
  frontier: readonly Ticket[],
): Promise<MarkerGap[]> {
  const wanted = new Set(
    frontier.flatMap((ticket) => ticket.leftFrontierBlockers ?? []),
  );
  if (wanted.size === 0) {
    return [];
  }
  let present: Set<string>;
  try {
    present = await mergeMarkersOnBase(cwd, base);
  } catch {
    return [];
  }
  const gaps: MarkerGap[] = [];
  for (const ticket of frontier) {
    for (const blockerId of ticket.leftFrontierBlockers ?? []) {
      if (!present.has(blockerId)) {
        gaps.push({ ticketId: ticket.id, blockerId, base });
      }
    }
  }
  return gaps;
}

/**
 * The one rendering, wherever the disclosure renders — Run start,
 * `run --preview`, and Doctor say the same words (ADR 0050). Marker terms
 * only: it names the Ticket, the blocker, and the base, states its own
 * blindness by naming the landings that leave no marker, and never says the
 * work is missing. Warnings never gate, and the good case is silent.
 */
export function writeMarkerGaps(
  stdout: { write(chunk: string): unknown },
  gaps: readonly MarkerGap[],
): void {
  for (const gap of gaps) {
    stdout.write(
      `Warning: the Tracker says Ticket ${gap.ticketId} is unblocked, but base ${
        shortCommit(gap.base)
      } does not contain Ticket ${gap.blockerId}'s merge marker on its first-parent history. Best-effort: a squash, a family Delivery pull request, a hand merge that rewrote messages, or a human-implemented blocker leaves no marker, so a missing marker is a question, not an answer — it never means the work is missing.\n`,
    );
  }
}
