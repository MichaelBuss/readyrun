# Clack is Init only, not a run wizard

Humans configure a Consumer with defineConfig (`readyrun.config.ts`) and start a Run with CLI flags (`run --max N`, `--permissions`, `--model`). Init is the one interactive moment: a Clack UI that writes that stub. A Clack wizard that assembles `readyrun run …` was rejected: every flag would exist twice, Doctor would have to explain both, and an unattended Run cannot prompt. Live Run status is stdout (or a later TUI), which is not Clack. Bare `readyrun` prints usage, not a menu.
