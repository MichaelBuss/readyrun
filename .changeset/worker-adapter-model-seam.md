---
"@readyrun/readyrun": minor
---

Each Worker Adapter answers the model question at the seam: `listModels` on the Adapter — Cursor its `--list-models` listing with the static fallback catalog, Claude its static catalog, opencode its `models` command in the bare-id grammar — read through `listedModels(adapter)`, with `ListedModel` now a public type. Init asks the seam instead of owning vendor binary names and output parsers, so a vendor rename or a listing-output change touches exactly one module; the select/autocomplete flows and the typed fallback prompt behave as before (ADR 0047).
