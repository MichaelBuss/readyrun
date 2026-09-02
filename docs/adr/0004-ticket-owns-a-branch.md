# One Ticket owns one Branch; the Ticket does not name it

When a Worker starts, the harness creates a Branch for that Ticket and refuses to start on main. The name is derived (Tracker id, Linear’s suggested name if the Adapter can read it, or a convention). Authors do not put a branch name on the Ticket — that would be special authoring on every issue, which we rejected. A worktree is a later isolation choice, not implied by this. How that Branch is published or integrated (push for review vs local-only then merge) is Policy and is not decided here.

ADR 0028 has since decided the local half: a Ticket's Branch is merged into the Run Branch and deleted when its Worker succeeds. Pushing and review remain open (#1).
