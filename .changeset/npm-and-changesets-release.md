---
"@readyrun/readyrun": minor
---

ReadyRun now publishes to npm as well as JSR, always at the same version, and releases run through Changesets. A Consumer installs from npm and gets `readyrun` on PATH (Node ≥ 24):

```sh
npm install @readyrun/readyrun
npx readyrun init
```

JSR installs keep working through JSR's npm compatibility layer.
