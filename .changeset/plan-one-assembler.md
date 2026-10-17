---
"@readyrun/readyrun": patch
---

Doctor's check and the Plan share one rooted-Frontier read: a rooted `readyrun doctor` (or `run --preview`) fetches the Frontier once instead of twice in the same command, and Doctor's verdict carries the read it made. Effort and Permissions resolve CLI-over-config with the default `ask` in one place — `resolveRunSettings` — instead of being re-derived at Doctor's verdict, the Worker spawn payload, and the Plan; `collectDoctorFailures` takes that one input instead of six positional parameters. Doctor's output and the rendered Plan are unchanged.
