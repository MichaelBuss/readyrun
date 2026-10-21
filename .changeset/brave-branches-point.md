---
"@readyrun/readyrun": patch
---

A merge that fails at the collect — after the Ticket's Worktree was removed, before the Run Branch ref was written — now hard-stops with a report that names the Ticket's surviving Branch: the one place the Worker's commits still sit, since nothing landed and no Worktree was kept. The report names the manual step of recovering the work from that Branch or deleting it before the Ticket can be picked again (#104, ADR 0049). The kept-Worktree hard stop and the landing line report exactly as before.
