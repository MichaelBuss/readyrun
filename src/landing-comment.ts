import { shortCommit } from "./git.ts";
import type { Landing } from "./tracker-adapter.ts";

// The Ticket's own Branch is gone by the time this is written (ADR 0028), so
// the Run Branch and the merge commit are the only pointers a reviewer has —
// and the ref is disclosed as local, because ReadyRun never pushes and a Ticket
// naming an unfetchable ref as though it were shared is a lie (ADR 0033).
export function landingComment(landing: Landing): string {
  return [
    "ReadyRun: this Ticket left the Frontier after a successful Worker.",
    "",
    `The work landed on the Run Branch \`${landing.runBranch}\` as merge commit \`${
      shortCommit(landing.mergeCommit)
    }\`. That ref is local to the machine that ran the Run — ReadyRun never pushes, so it cannot be fetched from anywhere else.`,
  ].join("\n");
}
