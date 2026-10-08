# Init detects GLOSSARY.md

The matt- skills renamed their domain-doc convention from `CONTEXT.md`/`CONTEXT-MAP.md` to `GLOSSARY.md`/`GLOSSARY-MAP.md` and only read the new names, so the canonical language file at a Consumer root is now a glossary by that name. Init's context-file detection follows: the no-prompt detection keeps ADR 0030's "the file is either there or it is not" shape, looks for `GLOSSARY.md`, and writes `contextFile: "GLOSSARY.md"` when it exists, omitting the key when it does not.

The config key stays `contextFile`. The option's job never named the glossary: it appends one Consumer-chosen repo file to the Worker prompt, and a Consumer whose context lives in `AGENTS.md` or `prompt.md` edits one line (ADR 0030). Naming the key after an external file convention would couple the config schema to a layout this package does not own — and that convention just moved. A Consumer still on `CONTEXT.md` keeps working by setting the key by hand.

This amends ADR 0030 in its filename detail only.
