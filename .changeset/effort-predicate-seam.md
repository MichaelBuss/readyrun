---
"@readyrun/readyrun": minor
---

The Worker Adapter seam answers the one Effort question beside its type: `mapsEffort` — does this Adapter map Effort (a flag plus a declared vocabulary) — and `declaredEffortVocabulary` — the values it declares (ADR 0042). Doctor's gate is unchanged, the Launcher's Effort question skips and offers by the predicate, and Init reads the declared constants instead of building throwaway Adapters to inspect them.
