# Doctor fails when the Consumer's install output is neither tracked nor ignored

#73 hard-stops a Run when a Worker exits 0 leaving its Worktree dirty, reading dirty as `git status --porcelain` (untracked files included). #64 installs dependencies inside the Worktree before spawn. A Consumer whose `.gitignore` does not cover that install output therefore hard-stops the first Ticket with `left work uncommitted`, naming a directory ReadyRun created. Every Ticket after it fails the same way.

Doctor already refuses config that lies about the Frontier (ADR 0009). Unignored install output is the same kind of lie about the Worktree, and it is answerable cheaply from the Consumer's own checkout: if ReadyRun would install, and `node_modules` is neither tracked nor ignored, Doctor fails and names the next action (add it to `.gitignore`). A Consumer that already ignores it sees no new output.

Auto-appending `node_modules` to `.gitignore` the way Init covers `.readyrun/` (ADR 0026) was rejected: `.readyrun/` is ReadyRun's directory, `node_modules` is the Consumer's install output, and guessing their ignore policy is not Init's job. Warn-and-continue was rejected because every Ticket would still hard-stop. Checking after install in the Worktree is too late; the first Ticket has already run.
