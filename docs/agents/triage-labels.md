# Triage Labels

`/matt-triage` speaks in terms of triage roles. This repo uses those role names verbatim as its label strings, so the mapping below is an identity mapping — there is no translation step.

## Category roles

Every triaged issue carries exactly one.

| Canonical role | Label in this repo's tracker | Meaning |
| -------------- | ---------------------------- | ------------------------------ |
| `bug` | `bug` | Something is broken |
| `enhancement` | `enhancement` | New feature or improvement |

## State roles

Every triaged issue carries exactly one.

| Canonical role | Label in this repo's tracker | Meaning |
| ----------------- | ---------------------------- | ---------------------------------------- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

## Labels outside the triage vocabulary

`spec` is not a state. It marks a published spec that acts as the parent for implementation tickets and is not itself work, so it sits alongside a state role rather than replacing one.

`documentation` narrows a category rather than replacing it; an issue carrying it still needs `bug` or `enhancement`.

Everything else GitHub creates by default (`duplicate`, `invalid`, `question`, `help wanted`, `good first issue`, `accessibility`) is unused by triage.

## History

`needs-refinement` was this repo's own state for "parked after the v0 grill, needs another session before it is spec." It was retired on 2026-09-04 in favour of `needs-triage`, whose canonical meaning already covers it, and the thirteen issues carrying it were migrated. Do not reintroduce a second name for "evaluation is not finished."
