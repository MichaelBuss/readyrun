---
"@readyrun/readyrun": patch
---

One call collects a finished Ticket: `collectTicket` on the git module removes the Worktree, merges the Ticket's Branch into the Run Branch as exactly one merge commit, deletes the Ticket's Branch, and returns the Landing — the remove-before-merge ordering now lives inside the module, and the Run loop assembles nothing. A Worktree that cannot be removed is reported as its own hard stop ("ReadyRun could not remove the Worktree at …") instead of a raw git error, and a merge failure no longer claims a kept Worktree the collect already removed. Run Branch membership, first-parent merge shape, and base-tip rules are unchanged (ADR 0028 / 0033 / 0034).
