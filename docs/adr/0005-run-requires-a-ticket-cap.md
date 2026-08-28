# A Run cannot start without a Ticket cap

A looping Run requires a maximum number of Tickets it may start. The unit is Tickets started, not dollars or the Worker’s internal turns (those can still be passed through to the coding CLI). Hitting the cap stops the Run; it does not prompt. A one-shot invocation is a Run with cap 1. Unlimited was rejected so an AFK loop cannot become an unbounded bill. Config may supply the number; absence of a cap is illegal.
