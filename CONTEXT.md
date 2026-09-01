# ReadyRun

**ReadyRun** is a TypeScript CLI that walks an external **Tracker** and runs a **Worker** in a fresh process per **Ticket**. It is not SpeechDeck, and it is not Ralph’s bash.

This file is the glossary and nothing else.

## Language

**ReadyRun**:
The product: the CLI and the published package.
_Avoid_: Ralph, spur, branchline, harness (as the product name)

**Tracker**:
The system that owns the queue of work. v0: GitHub or Linear. A later local **Tracker Adapter** would still be a **Tracker**, not a dump file the loop falls back to.
_Avoid_: ticket database, ralphctl store, fallback queue, Ralph

**Tracker Adapter**:
The **Tracker**-specific implementation that maps that tracker’s issue onto a **Ticket**. v0 ships `github` and `linear`; a Consumer building one for a Tracker this package doesn't ship (Jira, GitLab) calls the public `createTrackerAdapter` directly — the same building block `github()` and `linear()` use internally.
_Avoid_: plugin, SDK (the harness is not a vendor agent SDK), Adapter (unqualified)

**Worker Adapter**:
The coding-CLI-specific way to spawn a **Worker** (prompt, model, cwd; later, usage). v0: `cursor`, `claude`, and `custom`. Codex later. `cursor` and `claude` both take an optional `extraArgs: string[]` for a static vendor flag beyond model/effort, landing next to `--model` the same way `custom`'s `args` do. `cursor` and `claude` also expose an optional health probe **Doctor** can run cheaply (`agent status`, `claude auth status`); `custom` has none.
_Avoid_: plugin, SDK, recipe (as the noun)

**Ticket**:
The unit of work the loop picks and hands to a **Worker**. GitHub and Linear call this an issue; that word stays in the **Tracker Adapter**.
_Avoid_: issue (outside a **Tracker Adapter**), task, item

**Worker**:
A coding-CLI process started for exactly one **Ticket**, with a fresh context window.
_Avoid_: agent, session

**Frontier**:
The set of **Tickets** the loop may pick from next.
_Avoid_: queue, backlog, sprint

**Branch**:
The git ref created for a **Ticket** when its **Worker** starts. The name is derived by the harness / **Tracker Adapter**, not authored on the **Ticket**.
_Avoid_: main

**Worktree**:
The directory a **Worker** runs in; one per **Ticket**, on that **Ticket**’s **Branch**. The **Consumer**’s primary checkout is not the **Worker**’s cwd.
_Avoid_: clone, cwd mode

**Doctor**:
The check that config matches the **Tracker**. A **Run** will not start if it fails.
_Avoid_: lint (SpeechDeck’s word), validate

**Init**:
The command that writes a stub `readyrun.config.ts` in the **Consumer** root. Interactive (Clack). It does not assemble `run`.
_Avoid_: setup-ralph, generated `ralph/` folder, command wizard

**Consumer**:
A repo that depends on the package and supplies `defineConfig`. SpeechDeck (GitHub) and Trackunit (Linear) are the two v0 **Consumers**.
_Avoid_: host, target repo (as a noun)

**Run**:
One invocation of the loop, from start until the **Frontier** is empty, the cap is hit, or a hard stop.
_Avoid_: session, job, sprint

**Permissions**:
How freely a **Worker** may act without asking. `"ask"` or `"unattended"`. Default `"ask"`. Vendor flags (`--yolo`, `--dangerously-skip-permissions`) stay inside the **Worker Adapter**.
_Avoid_: yolo, autoApprove, boolean `yolo`

**Effort**:
How hard a **Worker** thinks on a **Ticket**. `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"`. Optional. The **Worker Adapter** maps it to that vendor's flag (`--effort` for Claude and custom). Cursor takes effort as a model variant, not a flag.
_Avoid_: max mode (Cursor's interactive slash command), ultracode (a Claude Code workflow setting)

## Relationships

- One **Consumer** config selects one **Tracker**. A repo is not GitHub-and-Linear at once.
- A **Tracker Adapter** talks to exactly one kind of **Tracker**. GitHub and Linear are both v0 **Tracker Adapters**.
- A **Worker Adapter** talks to exactly one kind of coding CLI. v0 ships `cursor`, `claude`, and `custom` (`bin` + args). Codex is later.
- The package is published (JSR) and depended on. It does not live inside a **Consumer**.
- If the chosen **Tracker** cannot be reached, the loop does not invent another **Tracker**. A local **Tracker Adapter** is a future option a **Consumer** would select on purpose.
- One **Ticket** is one **Worker**. The loop never gives two **Tickets** to one process.
- A parent id or a label query names a **Frontier**. It is not a **Ticket**.
- A **Frontier** is the **Tracker Adapter**’s answer to: `ready: "unblocked"` (string literal), plus a Consumer selector (GitHub labels, Linear state/label/project), plus an optional root (parent id or a list of **Ticket** ids). The **Ticket** body does not name the **Frontier**.
- When more than one **Ticket** is on the **Frontier**, pick order is the **Tracker Adapter**’s stable order (GitHub: issue number ascending). There is no priority field on the **Ticket**.
- When a **Worker** starts, the harness creates a **Branch** for that **Ticket**. It does not start on main. The **Ticket** body does not name the **Branch**.
- Each **Worker** runs in a **Worktree** on that **Branch**, even when a **Run** is serial. There is no cwd-isolation mode and no clone-per-**Ticket**.
- A **Run** (and **Doctor**) refuse to start if config lies about the **Frontier**: missing labels, repo ≠ remote, `unblocked` claimed but the **Tracker** cannot say so, unknown keys. Unused knobs (a label map with no matching **Tickets**) warn. The check is once at **Run** start, not every iteration.
- When a **Worker Adapter** defines a probe, **Doctor** runs it once the binary is confirmed to exist, and a probe failure is reported distinctly from a missing binary. A **Worker Adapter** with no probe (`custom` today) keeps the existence-only check unchanged.
- **ReadyRun** loads one `readyrun.config.ts` (same basename, JS/MJS allowed) at the **Consumer** root. **Init** writes that stub. There is no generated scripts folder and no search through other config filenames.
- **Init** is the only Clack UI. `run` and `doctor` are flags plus stdout. There is no wizard that assembles a `run` command. Bare `readyrun` is usage, not a menu. An unattended **Run** must not prompt.
- A **Run** cannot start without a cap: a maximum number of **Tickets** it may start. Hitting the cap stops the **Run**; it does not prompt. A single-**Ticket** invocation is a **Run** with cap 1. There is no unlimited **Run**.
- A v0 **Run** starts one **Worker** at a time. That is behaviour, not the isolation model: a **Worker** is already one **Ticket**, one **Branch**, one **Worktree**, so concurrency later is a knob, not a rewrite.
- **Permissions** are first-class on the **Run**: `"ask"` or `"unattended"`. Default `"ask"`. Never implied by looping. The **Worker Adapter** maps `"unattended"` to its flag; `custom` is told the flag. Sandbox-bypass is not a third value in v0.
- **Effort** is first-class on the **Run**: optional config default, CLI `--effort` for this **Run**. The **Worker Adapter** maps it to `--effort`; Cursor does not — pick a model variant instead. **Doctor** fails if effort is set on an adapter that does not map it. Not authored on the **Ticket**.
- A **Worker**’s model: config default is required (**Doctor** fail if missing). CLI `--model` overrides that default for the **Run**. A label map may override per **Ticket**. The **Ticket** body does not name a model.
- The **Worker** prompt is owned by the package: loop rules plus **Tracker Adapter** copy (this **Ticket**’s id, title, body, URL). A **Consumer** may append a repo context file from config. That file does not replace tracker instructions. There is no repo `prompt.md` that owns the loop.
- When a **Worker** succeeds, the **Ticket** must leave the **Frontier**. The **Tracker Adapter** has a default for that (Linear: In Review, not Done; GitHub: drop the frontier label, comment, do not close). A **Consumer** may override; they do not have to write a hook.
- A **Run** hard-stops (no skip, no retry-forever) on **Tracker** API or auth failure, **Branch**/**Worktree** failure, **Worker** missing or not logged in at spawn, or **Worker** non-zero exit. Empty **Frontier** and cap are clean stops. The harness owns **Tracker** auth; the coding CLI owns its own login.

## Example dialogue

> **Dev:** "Do I copy a `ralph/` folder into SpeechDeck?"
> **Domain expert:** "No. You depend on the package and write `defineConfig`. SpeechDeck is a **Consumer**, not the home of the loop."
>
> **Dev:** "Can this repo be GitHub and Linear?"
> **Domain expert:** "No. One **Consumer**, one **Tracker**. Pick the GitHub **Tracker Adapter** or the Linear **Tracker Adapter**."
>
> **Dev:** "If GitHub is down, do we switch to a local file?"
> **Domain expert:** "No. That's a stop, not a different **Tracker**. A local **Tracker Adapter** is something you'd choose in config, later, not a fallback."
>
> **Dev:** "Is GitHub #52 an Issue?"
> **Domain expert:** "GitHub calls it an issue. The loop calls it a **Ticket**. The GitHub **Tracker Adapter** translates."
>
> **Dev:** "Do I point the **Worker** at the parent and let it eat the tree?"
> **Domain expert:** "No. The parent names the **Frontier**. The **Worker** gets one **Ticket**."
>
> **Dev:** "How do I say which **Tickets** are in play?"
> **Domain expert:** "Unblocked, plus your labels or Linear state. Optionally a parent or a list of ids. That's the **Frontier**. Not a sentence on the issue."
>
> **Dev:** "#53 and #57 are both unblocked. Which **Worker** starts?"
> **Domain expert:** "#53. GitHub number, lowest first. You don't put priority on the **Ticket**."
>
> **Dev:** "Where do I put the Linear vs GitHub paragraph?"
> **Domain expert:** "You don't. **Init** writes `readyrun.config.ts`. You pick the **Tracker Adapter** there. No `ralph/` folder."
>
> **Dev:** "Can I get a Clack menu that builds `readyrun run --max 5`?"
> **Domain expert:** "No. Clack is **Init**. `run` is flags. Unattended cannot ask you."
>
> **Dev:** "Do I put the branch name on the GitHub issue?"
> **Domain expert:** "No. When the **Worker** starts, the harness makes a **Branch** from the **Ticket** id. You don't author that."
>
> **Dev:** "Can I start a **Run** with no max and just stop it later?"
> **Domain expert:** "No. A **Run** needs a cap. That's how many **Tickets** it may start. When it hits the number, it stops."
>
> **Dev:** "The **Worker** finished #52. Do we close it?"
> **Domain expert:** "Not on GitHub — we drop the frontier label so the **Run** doesn't pick it again. Linear goes to In Review, not Done. Done is for merge."
>
> **Dev:** "#53 and #57 are both unblocked. Does one **Run** start both?"
> **Domain expert:** "Not in v0. One **Worker** at a time. Each still has its own **Branch** and **Worktree**, so later we can raise concurrency without changing that."
>
> **Dev:** "The label in config doesn't exist on GitHub. Does the **Run** start?"
> **Domain expert:** "No. **Doctor** fails, and a **Run** won't start. That's a lie about the **Frontier**. A review-model map with no review **Tickets** is a warn."
>
> **Dev:** "It's a looping **Run**, so that's yolo, right?"
> **Domain expert:** "No. Looping is not **Permissions**. Default is ask. Pass `"unattended"` if you mean it. We don't say yolo."
>
> **Dev:** "Do I put `opus` on the GitHub issue?"
> **Domain expert:** "No. Default is in config. `--model` for this **Run**. A label map if this **Ticket**'s labels say so."
>
> **Dev:** "The **Worker** exited 1. Do we start #53?"
> **Domain expert:** "No. The **Run** stops. We don't skip, and we don't retry GitHub until it works."
>
> **Dev:** "Do I copy prompt.md and change Linear to GitHub?"
> **Domain expert:** "No. The package tells the **Worker** it's GitHub #52 because you picked that **Tracker Adapter**. You may append a repo context file for how to test. You don't author the loop."

## Flagged ambiguities

- **Product name** — resolved: **ReadyRun**. CLI `readyrun`. Not Ralph, not spur (PATH and category collision with two agent harnesses).
- **Issue vs Ticket** — resolved: **Ticket** is ours. “Issue” is GitHub’s and Linear’s word, used only inside a **Tracker Adapter**.
- **Adapter** — resolved: unqualified “Adapter” is not a glossary noun. **Tracker Adapter** and **Worker Adapter** are different jobs.
- **Local Adapter** — resolved: not v0; later it is a first-class **Tracker** option, never a fallback when GitHub or Linear fail.
- **Beads** — not in scope unless someone wants a git-native **Tracker**.
- **Worktree** — resolved: v0 uses a git **Worktree** per **Ticket**, even while serial. Not a clone. Not the **Consumer** cwd.
- **Parallelism** — resolved for v0 behaviour: serial. Not resolved as “forever serial.” The shape must make raising concurrency later easy.
- **How a Ticket lands** — unresolved. Push-for-review vs stay local, auto-review, integrate later are Policy, not the definition of **Branch**.
- **Run stats** — unresolved. Token usage, context-window % across **Workers**, printed at the end of a **Run**. Wanted; not v0-blocking.
- **Automatic review** — resolved for v0: no. A review **Ticket** on the **Frontier** is just a **Ticket**. A second **Worker** that reviews the first is later.
- **Permissions** — resolved: `"ask"` | `"unattended"`. Default ask. Not yolo. Not a boolean.
- **Effort** — resolved: optional config default; CLI overrides the **Run**. Adapter maps to `--effort`. Cursor does not map the flag (model variants). **Doctor** fails that pairing. Not ultracode, not max-mode.
- **Model** — resolved: required config default; CLI overrides the **Run**; label map overrides per **Ticket**. Not authored on the **Ticket**.
- **Hard stop** — resolved: **Tracker**/git/**Worker** failure ends the **Run**. No skip, no retry-forever. Cap and empty **Frontier** are clean stops. Harness owns **Tracker** auth; CLI owns Worker login.
- **Worker prompt** — resolved: package + **Tracker Adapter**. Optional Consumer context file. Not a repo-owned `prompt.md`.
- **Frontier query** — resolved: `ready: "unblocked"` + selector + optional root. Not parent-only, not labels without unblocked.
- **Pick order** — resolved: stable **Tracker Adapter** order (GitHub: issue number ascending). No priority on the **Ticket**.
- **Config file** — resolved: `readyrun.config.ts` at the **Consumer** root. **Init** writes it. No `ralph/` scripts, no cosmiconfig.
- **Clack** — resolved: **Init** only. Not a command assembler in front of `run`.
