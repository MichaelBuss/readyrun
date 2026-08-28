# Ubiquitous language is Ticket, not Issue

The loop’s unit of work is a Ticket. GitHub and Linear both say “issue”; that word stays inside the Adapter that maps their issue onto a Ticket. Calling the generic type Issue would leak tracker vocabulary into the Loop and Policy, and it fights the same rename (to-tickets, not to-issues) already made in the ticket-writing skill. A Frontier is a set of Tickets, not a Ticket.
