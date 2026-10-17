# @readyrun/readyrun

## 0.2.1

### Patch Changes

- [#183](https://github.com/MichaelBuss/readyrun/pull/183) [`b9c5a74`](https://github.com/MichaelBuss/readyrun/commit/b9c5a74add8b7c4443d24a8e64a411de8c592e84) Thanks [@MichaelBuss](https://github.com/MichaelBuss)! - The npm tarball ships compiled JavaScript instead of TypeScript sources: `npm run build` emits `dist/` (`*.js` + `*.d.ts`) and the npm `bin` and `exports` point at the compiled files. Node refuses to strip types for files under `node_modules`, so 0.2.0's TS-only npm artifact failed to load for every consumer — `readyrun` on PATH and `import "@readyrun/readyrun"` alike died with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. JSR keeps publishing the sources, versions stay in lockstep, and a consumer's own `readyrun.config.ts` (outside `node_modules`) still loads via Node's default type stripping.

## 0.2.0

### Minor Changes

- [#178](https://github.com/MichaelBuss/readyrun/pull/178) [`d3f0521`](https://github.com/MichaelBuss/readyrun/commit/d3f0521db507e9165f947068bd76741c12c2bf7c) Thanks [@MichaelBuss](https://github.com/MichaelBuss)! - ReadyRun now publishes to npm as well as JSR, always at the same version, and releases run through Changesets. A Consumer installs from npm and gets `readyrun` on PATH (Node ≥ 24):
  
  ```sh
  npm install @readyrun/readyrun
  npx readyrun init
  ```
  
  JSR installs keep working through JSR's npm compatibility layer.
