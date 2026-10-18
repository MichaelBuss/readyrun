---
"@readyrun/readyrun": minor
---

The Run consumes the Plan. `run()` resolves the Plan — Doctor's verdict, the
Frontier in pick order, the base, the Run Branch, the cap, and the Workers'
Effort and Permissions — and its loop (`runPlan`, exported alongside) reads
every fact from that Plan: no first-iteration re-derivation of Doctor's rules,
the Plan's Frontier snapshot is the first pick, and the Run collects onto the
Run Branch the Plan named ("named when the Plan is computed"). The loop
re-verifies only what can change mid-loop: the cwd-fidelity probe at start,
and a fresh Frontier read every iteration after the first, which still lets
waiting Tickets join when their blockers clear. The Plan module owns its input
shape (`PlanInput`; `RunOptions` is now its alias), closing the import cycle
with the Run module, and a Launcher→Run session reads the Tracker once per
fact — the Run adds no start reads, asserted by fixture call counts. A refusal
in the rendered Plan is refused by the Run without re-reading the Tracker.
