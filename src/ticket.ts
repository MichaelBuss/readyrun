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
  /** The id of the parent Ticket, when the Tracker knows one. */
  parent?: string;
};
