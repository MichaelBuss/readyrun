# v0 checkout is a git worktree per Ticket

Even a serial Run puts each Worker in a git worktree on that Ticket’s Branch. The Consumer’s primary checkout is left alone. A cwd-isolation mode and a fresh clone per Ticket were rejected: cwd makes later concurrency a rewrite and two terminals fight; clone is slower and worse for auth with no current use. How long a worktree lives, and whether its Branch is pushed, is still Policy.

Lifetime has since been decided in ADR 0029, and where the Branch lands in ADR 0028. Whether anything is pushed remains open (#1).
