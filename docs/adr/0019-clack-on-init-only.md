# Clack is Init only, not a run wizard

> Superseded in part by [ADR 0040](0040-a-launcher-assembles-a-run-on-a-tty.md): bare `readyrun` opens a Launcher on a TTY. Init stays Clack, `run`/`doctor` remain flags plus stdout, and an unattended Run still never prompts.

Humans configure a Consumer with defineConfig (`readyrun.config.ts`) and start a Run with CLI flags (`run --max N`, `--permissions`, `--model`). Init is interactive by default: a Clack UI that writes that stub. That is not an argument against a scriptable Init — `--answers <file>` populates the same InitAnswers Clack would, so CI or a template-repo setup script can drive Init without a TTY. A Clack wizard that assembles `readyrun run …` was rejected: every flag would exist twice, Doctor would have to explain both, and an unattended Run cannot prompt. Live Run status is stdout (or a later TUI), which is not Clack. Bare `readyrun` prints usage, not a menu.
