---
"@readyrun/readyrun": minor
---

One argv grammar serves all four Worker Adapters: `custom()` rides the same argv assembly the print-mode Adapters use — its declared `args` as the leading args, print mode suppressed, since the wrapped binary may still be able to ask — and the assembler owns the grammar's name (`assembledWorker`, `printMode` a declared fact). An unknown `{placeholder}` in declared args is refused when the Adapter is built, as a named `UnknownPlaceholderError`, instead of failing Doctor or a Run later; Doctor no longer inspects the Worker Adapter's argv shape (`staticArgv` is gone), and the spawn plumbing is no longer exported — Worker Adapter tests drive the factories (#174).
