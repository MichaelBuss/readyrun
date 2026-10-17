---
"@readyrun/readyrun": patch
---

The npm tarball ships compiled JavaScript instead of TypeScript sources: `npm run build` emits `dist/` (`*.js` + `*.d.ts`) and the npm `bin` and `exports` point at the compiled files. Node refuses to strip types for files under `node_modules`, so 0.2.0's TS-only npm artifact failed to load for every consumer — `readyrun` on PATH and `import "@readyrun/readyrun"` alike died with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. JSR keeps publishing the sources, versions stay in lockstep, and a consumer's own `readyrun.config.ts` (outside `node_modules`) still loads via Node's default type stripping.
