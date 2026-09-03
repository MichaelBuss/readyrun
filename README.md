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

`claude()` and `custom()` map an optional `effort` config default (`"low" | "medium" | "high" | "xhigh" | "max"`) onto `--effort`:

```ts
defineConfig({
  worker: claude(),
  model: "opus",
  permissions: "unattended",
  effort: "high",
});
```

`cursor()` has no such flag — Cursor's equivalent is a model variant (e.g. `composer-2.5-fast`), not a flag; Doctor fails a Run that sets `effort` on `cursor()`.

`cursor()` and `claude()` also accept an optional `extraArgs: string[]` for any other static vendor flag beyond model/effort, landing in the same position `custom()`'s own `args` occupy relative to `--model`, without dropping to `custom()`:

```ts
claude({ extraArgs: ["--verbose"] });
```

`cursor()` shells out to `agent`, `claude()` shells out to `claude`; both must already be installed and authenticated before `run` — ReadyRun does not manage CLI auth.

Both spawn print-mode (`-p`). `permissions: "ask"` (the default) is a Doctor failure — print-mode is not a chat. Pass `--permissions unattended`, or set `permissions: "unattended"` in config. `custom()` does not force print-mode, so ask remains valid there.

`readyrun init` writes that line for you rather than asking, and points `contextFile` at a `CONTEXT.md` when the Consumer root already has one:

```ts
export default defineConfig({
  tracker: github({
    repo: "acme/widgets",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: cursor(),
  model: "composer-2",
  permissions: "unattended",
  contextFile: "CONTEXT.md",
});
```

Without a `CONTEXT.md` the key is absent and the Worker gets tracker copy alone. `--answers` writes the same stub without a TTY.

`readyrun doctor` can tell "not installed" from "installed but not logged in": `cursor()` and `claude()` each define a cheap probe (`agent status`, `claude auth status`) that Doctor runs once it has confirmed the binary exists, reporting a probe failure distinctly from a missing binary. `custom()` Worker Adapters have no probe and keep today's existence-only check.

Doctor also fails when a Consumer lockfile's install output (`node_modules`) is neither tracked nor ignored, and names adding it to `.gitignore` — otherwise every Ticket hard-stops as Worker dirt after ReadyRun's own install.

For a Tracker this package doesn't ship (Jira, GitLab, ...), build one with `createTrackerAdapter`, the same building block `github()` and `linear()` use internally:

```ts
import { createTrackerAdapter, defineConfig } from "@readyrun/readyrun";

const jira = createTrackerAdapter({
  frontier() { /* return this Tracker's ready Tickets */ },
  leaveFrontier(ticket) { /* move the Ticket off the Frontier */ },
});

defineConfig({ tracker: jira, worker: cursor(), model: "composer-2" });
```

`branchName`, `promptCopy`, and `inspect` fall back to sane defaults if omitted.

```sh
readyrun init
readyrun init --answers answers.json
readyrun doctor
readyrun run --max 5
```

JSR does not put `readyrun` on PATH. Run the `cli` export as a program (Deno):

```sh
deno run -A jsr:@readyrun/readyrun/cli init
deno run -A jsr:@readyrun/readyrun/cli init --answers answers.json
deno run -A jsr:@readyrun/readyrun/cli doctor
deno run -A jsr:@readyrun/readyrun/cli run --max 5
```

pnpm/npm/yarn: JSR's npm-compat tarball strips `bin`, so `pnpm exec readyrun` and `npx readyrun` fail with no hint at the fix. Import the `cli` export from a two-line wrapper script instead, and call that from a `package.json` script:

```js
// readyrun-cli.mjs
import { cli } from "@readyrun/readyrun/cli";
process.exitCode = await cli({ argv: process.argv.slice(2) });
```

```json
{
  "scripts": {
    "readyrun": "node readyrun-cli.mjs"
  }
}
```

```sh
pnpm readyrun init
pnpm readyrun init --answers answers.json
pnpm readyrun doctor
pnpm readyrun run --max 5
```

From this repo, `package.json` `bin` maps `readyrun` to `src/cli.ts` (Node 24).
