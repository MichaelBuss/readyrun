function loopRules(worktree: string, branch: string): string {
  return `You are implementing exactly one Ticket. Do not start neighbouring work.

Your working directory is ${worktree}. Commit your work on branch ${branch}. ReadyRun checks that you did: exiting with uncommitted changes, or leaving the Branch's tree matching the base it was cut from, is a failed Ticket.

You will not get a reply. Do not ask the Consumer. Decide from the Ticket, the context file, and the repo (CONTEXT.md, docs/adr/). A blocking question is a failed Ticket, not a pause.

Do not invent a Tracker.
Do not fabricate Ticket state.
Do not retry a failed Tracker call in a loop.`;
}

export function composeWorkerPrompt(
  trackerCopy: string,
  worktree: string,
  branch: string,
  context?: string,
): string {
  const parts = [loopRules(worktree, branch), trackerCopy];
  if (context !== undefined && context.length > 0) {
    parts.push(context);
  }
  return parts.join("\n\n");
}
