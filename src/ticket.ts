/**
 * The unit of work the loop picks and hands to a Worker. GitHub and Linear
 * call this an issue; that word stays inside the Tracker Adapter.
 */
export type Ticket = {
  /** The Tracker's own id: a GitHub number or a Linear identifier. */
  id: string;
  /** The Tracker's title, as the Worker prompt names the Ticket. */
  title: string;
  /** The Tracker's body, handed to the Worker verbatim. */
  body: string;
  /** The Tracker's URL, so the Worker can reference the Ticket. */
  url: string;
  /** The labels on the Ticket; `modelsByLabel` reads them. */
  labels: string[];
  /** The ids of open Tickets blocking this one; empty when unblocked. */
  blockedBy: string[];
  /**
   * The ids of blockers that have left the Frontier — the blocking relation's
   * other half, which `unblocked` drops to make the Ticket eligible (ADR 0016)
   * and ADR 0050 hands to the Plan so it can check the blockers' merge markers
   * against the base. The same Tracker judgment that answered `blockedBy`
   * answers this, so an Adapter needs no git to carry it; absent means the
   * Adapter answers none.
   */
  leftFrontierBlockers?: string[];
  /** The id of the parent Ticket, when the Tracker knows one. */
  parent?: string;
  /**
   * The Tracker's own suggested Branch name, when the Tracker suggests one
   * (Linear does). It travels on the answer that discovered it; absent means
   * `branchName`'s convention names the Branch (ADR 0004).
   */
  suggestedBranch?: string;
};
