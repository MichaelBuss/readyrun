# v0 Run is serial; isolation is already per-Ticket

v0 starts one Worker at a time so the first ship is still a loop, not a factory. Parallel unblocked Tickets are faster and should not require a redesign: a Worker is already one Ticket, one Branch, one checkout. Checking the Ticket Branch out in the Consumer’s cwd was rejected as the v0 *shape* — that would make concurrency a rewrite. Raising concurrency later is a knob; claiming a Ticket so two Workers cannot pick the same one is part of that later step, not a reason to skip per-Ticket isolation now.
