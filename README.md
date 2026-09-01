# ReadyRun

A TypeScript CLI that walks a tracker **Frontier** and runs one coding **Worker** per **Ticket**, in a fresh process, on its own **Branch** and **Worktree**.

This repo is the product. It is not SpeechDeck. SpeechDeck (and later Trackunit) will *depend* on it.

Spec: [`docs/specs/readyrun-v0.md`](./docs/specs/readyrun-v0.md). Language: [`CONTEXT.md`](./CONTEXT.md). Decisions: [`docs/adr/`](./docs/adr/).

Package: `@readyrun/readyrun` on [JSR](https://jsr.io/@readyrun/readyrun), not npmjs.com. A **Consumer** installs with npm/pnpm/yarn through JSR’s compatibility layer, then writes `readyrun.config.ts`.

```sh
pnpm add jsr:@readyrun/readyrun
# npm:
npx jsr add @readyrun/readyrun
```

```ts
import { defineConfig, github, cursor } from "@readyrun/readyrun";
```

`cursor()` and `claude()` accept an optional `extraArgs: string[]` for a static vendor flag beyond model — Effort already has a first-class `effort` config default (see below), but any other flag your Worker binary takes can be passed the same way `custom()`'s `args` are, without dropping to `custom()`:

```ts
cursor({ extraArgs: ["--reasoning-effort", "high"] });
claude({ extraArgs: ["--verbose"] });
```

```sh
readyrun init
readyrun doctor
readyrun run --max 5
```

JSR does not put `readyrun` on PATH. Run the `cli` export as a program (do not import it):

```sh
deno run -A jsr:@readyrun/readyrun/cli init
deno run -A jsr:@readyrun/readyrun/cli doctor
deno run -A jsr:@readyrun/readyrun/cli run --max 5
```

From this repo, `package.json` `bin` maps `readyrun` to `src/cli.ts` (Node 24).
