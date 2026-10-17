---
"@readyrun/readyrun": minor
---

Linear's suggested Branch name travels on the answer instead of in the Adapter: the Linear Tracker Adapter maps Linear's own `branchName` onto each **Ticket**'s new optional `suggestedBranch`, so `frontier`, `waiting`, and `tree` hand the caller the suggestion with the **Ticket** it belongs to (ADR 0004, #167), and `branchName` — now derived once in the **Tracker Adapter** defaults — reads the **Ticket** it is handed rather than a map only a prior `frontier` read could have seeded. Behaviour on a **Run** is unchanged: a Linear **Ticket** with a suggestion still works the suggested name, and one without still gets `readyrun/<id>`.
