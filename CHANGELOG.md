# @readyrun/readyrun

## 0.2.0

### Minor Changes

- [#178](https://github.com/MichaelBuss/readyrun/pull/178) [`d3f0521`](https://github.com/MichaelBuss/readyrun/commit/d3f0521db507e9165f947068bd76741c12c2bf7c) Thanks [@MichaelBuss](https://github.com/MichaelBuss)! - ReadyRun now publishes to npm as well as JSR, always at the same version, and releases run through Changesets. A Consumer installs from npm and gets `readyrun` on PATH (Node ≥ 24):
  
  ```sh
  npm install @readyrun/readyrun
  npx readyrun init
  ```
  
  JSR installs keep working through JSR's npm compatibility layer.
