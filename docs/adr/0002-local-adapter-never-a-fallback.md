# Local adapter is a future Tracker, never a fallback

v0 talks only to GitHub and Linear. A local-file adapter may exist later as one more Tracker a Consumer selects in config. It is not Ralph’s `--local` escape hatch: if the chosen Tracker is down, the loop stops; it does not invent a second queue. Two sources of truth were rejected for v0 and for any future local option.
