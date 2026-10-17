---
"@readyrun/readyrun": minor
---

The Linear Tracker Adapter stands on the same Tracker Adapter floor as GitHub: its `frontier`, `waiting`, and `tree` are thin partitions over one rooted candidates read, so root precedence (the explicit list bypasses the selector but never `ready: "unblocked"`; the parent narrows the selector and is never worked itself) and pick order (identifier ascending) are written once, and pagination, the GraphQL transport, and the blocking-expression schema probe are shared instead of copied. One truth comes with the floor: a Ticket that has left the Frontier is not an open candidate, so a Linear state selector naming a finished Ticket's state no longer picks it.
