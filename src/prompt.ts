const LOOP_RULES = `You are implementing exactly one Ticket. Do not start neighbouring work.

You will not get a reply. Do not ask the Consumer. Decide from the Ticket, the context file, and the repo (CONTEXT.md, docs/adr/). A blocking question is a failed Ticket, not a pause.

Do not invent a Tracker.
Do not fabricate Ticket state.
Do not retry a failed Tracker call in a loop.`;

export function composeWorkerPrompt(
  trackerCopy: string,
  context?: string,
): string {
  const parts = [LOOP_RULES, trackerCopy];
  if (context !== undefined && context.length > 0) {
    parts.push(context);
  }
  return parts.join("\n\n");
}
