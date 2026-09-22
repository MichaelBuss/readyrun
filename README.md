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

Each Worker Adapter declares the Effort vocabulary it can honestly map (ADR 0042), and the config's `effort` field is typed against that declaration — an out-of-vocabulary value is a compile error, and Doctor fails what slips through at runtime (a JS config file, or the deliberately wide `--effort` parse). `claude()` declares all five (`"low" | "medium" | "high" | "xhigh" | "max"`) and maps them onto `--effort`:

```ts
defineConfig({
  worker: claude(),
  model: "opus",
  permissions: "unattended",
  effort: "high",
});
```

`cursor()` declares none — Cursor's equivalent is a model variant (e.g. `composer-2.5-fast`), not a flag, so `effort` on `cursor()` fails to compile and Doctor refuses it in a loaded config. `opencode()` declares only `high` | `max` — its effort knob is `--variant`, whose values are provider-specific — and maps the declared values onto `--variant`. `custom()` maps no Effort until it declares both the flag its binary takes and the values it can honestly pass; a flag without a declaration is a Doctor config lie, and only declared values are ever passed:

```ts
custom({
  bin: "my-agent",
  unattendedFlag: "--dangerously-skip-permissions",
  effortFlag: "--effort",
  effortVocabulary: ["low", "high"],
});
```

`cursor()`, `claude()`, and `opencode()` also accept an optional `extraArgs: string[]` for any other static vendor flag beyond model/effort, landing in the same position `custom()`'s own `args` occupy relative to `--model`, without dropping to `custom()`:

```ts
claude({ extraArgs: ["--verbose"] });
```

`custom()`'s `args` and print-mode `extraArgs` may reference the Worker's Worktree with a `{cwd}` token, interpolated per spawn with the Worktree's absolute path — the anchor for CLIs that resolve their own project root instead of process cwd:

```ts
custom({ bin: "my-agent", args: ["--project", "{cwd}"], unattendedFlag: "--go" });
```

`opencode()` passes that anchor itself — `run --dir {cwd}` — because opencode re-roots linked worktrees to the git common dir, so its Worker is pinned by argv, never by process cwd.

The token is reserved: any other `{...}` placeholder is a Doctor failure, and a literal `{cwd}` cannot be passed through.

`cursor()` shells out to `agent`, `claude()` to `claude`, and `opencode()` to `opencode run`; all must already be installed and authenticated before `run` — ReadyRun does not manage CLI auth.

All three spawn print-mode (`-p` for `agent` and `claude`, `run` for `opencode`). `permissions: "ask"` (the default) is a Doctor failure — print-mode is not a chat. Pass `--permissions unattended`, or set `permissions: "unattended"` in config. `custom()` does not force print-mode, so ask remains valid there.

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

`readyrun doctor` can tell "not installed" from "installed but not logged in": `cursor()` and `claude()` each define a cheap probe (`agent status`, `claude auth status`), and `opencode()` judges the output of `auth list` — that command exits 0 either way, so zero credentials is the not-logged-in answer. Doctor runs the probe once it has confirmed the binary exists, reporting a probe failure distinctly from a missing binary. `custom()` Worker Adapters have no probe and keep today's existence-only check.

Doctor also fails when a Consumer lockfile's install output (`node_modules`) is neither tracked nor ignored, and names adding it to `.gitignore` — otherwise every Ticket hard-stops as Worker dirt after ReadyRun's own install.

For a Tracker this package doesn't ship (Jira, GitLab, ...), build one with `createTrackerAdapter`, the same building block `github()` and `linear()` use internally:

```ts
import { createTrackerAdapter, defineConfig } from "@readyrun/readyrun";

const jira = createTrackerAdapter({
  frontier() { /* return this Tracker's ready Tickets */ },
  leaveFrontier(ticket, landing) {
    /* move the Ticket off the Frontier, and say where its work went:
       landing.runBranch and landing.mergeCommit, local to this machine */
  },
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

A **Run** works the top of the **Frontier** your selector names: `ready: "unblocked"` plus your labels or Linear state. To name which **Tickets** a Run should work, root the Frontier on the command line ([ADR 0038](./docs/adr/0038-run-names-the-frontier-root.md)): `--ticket <id-or-url>` (repeatable) runs exactly those Tickets — re-driving a failed Ticket, or a hand-picked slice, without touching the config — and `--root <parent>` runs that parent's children, the parent never worked itself. A blocked named Ticket is waiting work, not an error: it warns and joins when its blocker lands. Naming is not sequencing; the Tracker still picks in its stable order, and an explicit list defaults the cap to its length. `doctor` takes the same root flags, so a rooted lie-check can be pre-flighted without starting a Run:

```sh
readyrun run --ticket 53
readyrun run --max 3 --ticket 52 --ticket https://github.com/acme/widgets/issues/57
readyrun run --max 5 --root 131
readyrun doctor --root 131
```

A **Run** cuts every **Worktree** from your checkout unless `--base <commit-ish>` names another commit; either way it leaves your checkout where it is. Hitting the cap ends a **Run**, so carrying on is a *new* **Run** based on the **Run Branch** the last one built ([ADR 0034](./docs/adr/0034-continuing-a-capped-run-is-a-new-run-with-an-explicit-base.md)) — and a cap stop prints that command, so there is no timestamp to remember:

```
Run complete: cap of 2 Tickets reached; the Frontier may still hold work
2 Tickets landed on readyrun/run-20260904-152033, cut from 68a6987.
Continue with: readyrun run --max 2 --base readyrun/run-20260904-152033
```

Before committing to a **Run**, `run --preview` prints the **Plan** ([ADR 0039](./docs/adr/0039-the-plan-computed-once-rendered-read-only.md)) — Doctor's verdict, the **Frontier** in pick order, which **Tickets** wait and on what, the resolved base, the **Run Branch**, and the cap with where it came from — and closes with the exact equivalent `readyrun run …` command. It starts nothing: no Worker, no Worktree, no Run Branch, and it skips Doctor's cwd-fidelity probe (the **Run** proves that at start):

```
$ readyrun run --preview --max 3
Run preview: nothing starts; this Plan is read-only
Doctor: pass
Frontier: 2 Tickets in pick order
  1. 52 First up
  2. 54 Second up
Waiting: 1 Ticket off the Frontier
  57 waits on 52
Base: 68a6987 on main
Run Branch: readyrun/run-20260920-101500 (named when the Run starts)
Cap: 3 Tickets from --max
Cwd-fidelity probe: not run; the Run proves it at start
Run with: readyrun run --max 3
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
