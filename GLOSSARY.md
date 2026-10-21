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

**Tracker Adapter floor**:
The shared skeleton the shipped **Tracker Adapters** stand on: one rooted open candidates read — root precedence, the paging loop, pick order, the split into the **Frontier** and waiting halves — plus the GraphQL transport and the blocking-expression probe, each written once so no Adapter carries a copy. The Adapter brings the **Tracker**'s own facts: which candidates match its selector, what an open candidate looks like, how a candidate maps onto a **Ticket**, and which named **Ticket** is a lie.
_Avoid_: base class, shared parent, helper module

**Worker Adapter**:
The coding-CLI-specific way to spawn a **Worker** (prompt, model, cwd; later, usage). v0: `cursor`, `claude`, `opencode`, and `custom`. Codex later. `cursor`, `claude`, and `opencode` all take an optional `extraArgs: string[]` for a static vendor flag beyond model/effort, landing next to `--model` the same way `custom`'s `args` do. `cursor`, `claude`, and `opencode` also expose an optional health probe **Doctor** can run cheaply (`agent status`, `claude auth status`, and `opencode`'s `auth list` judged for zero credentials, that command exiting 0 either way); `custom` has none. Each Adapter also answers the model question (`listModels`): Cursor its own `--list-models` listing with a static fallback catalog, Claude a static catalog, opencode its `models` command in a bare-id grammar, empty when nothing can be listed honestly; `custom` answers none, and the placeholder the typed fallback offers is the Adapter's too (opencode: `provider/model`). **Init** asks that seam and holds no vendor grammar (ADR 0047). `opencode` passes its own Worktree anchor (`run --dir {cwd}`): it re-roots linked worktrees to the git common dir, so process cwd is never trusted.
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

**Root**:
What a **Frontier** is rooted at, named on the command line per **Run**: a parent **Ticket**, whose children become the **Frontier**, or an explicit list of **Tickets**. The list bypasses the Consumer selector but never `ready: "unblocked"`; the parent narrows the selector's **Frontier** to its children, and is itself never worked.
_Avoid_: scope, focus, target list, allowlist

**Tree**:
What a tree rendering reads from a **Tracker Adapter** in one read-only look: the parent **Root**'s own **Ticket** — a parent is never worked — when a parent **Root** is named, and the named **Root**'s open candidates — the selector's, when none is named — split into the **Frontier** and the **Tickets** waiting off it, each waiting **Ticket** carrying its blockers. `frontier` and `waiting` answer the halves; `tree` answers both together, or refuses when the Adapter cannot answer it honestly.
_Avoid_: hierarchy (unqualified), forest

**Branch**:
The git ref created for a **Ticket** when its **Worker** starts. The name is derived by the harness / **Tracker Adapter**, not authored on the **Ticket**; a **Tracker**'s own suggested name (Linear hands each issue one) is a fact about the **Ticket** the **Tracker Adapter** maps on, and it travels on the answer that discovered it.
_Avoid_: main

**Run Branch**:
The one **Branch** a **Run** collects its finished **Tickets** onto, so a **Run** leaves one thing to review instead of one per **Ticket**. Its namespace is the `readyrun/run-` prefix, and membership there is what makes a checkout's branch count as a **Run Branch**.
_Avoid_: integration branch, trunk, main

**Landing**:
Where a finished **Ticket**'s work went: the **Run Branch** it was collected onto and the merge commit that collected it. What a **Ticket** is told as it leaves the **Frontier**, because its own **Branch** is gone by then.
_Avoid_: handoff, location (unqualified), PR, remote

**Delivery**:
What a **Consumer** makes of a settled **Landing**: the published state on the forge — refs and PRs — rendered by the `deliver` command (ADR 0048). A **Delivery** never merges anything and never reaches into a **Run**: the **Run**'s report is the whole handoff until the **Consumer** runs `deliver`.
_Avoid_: integration, ship, deploy, publish (as the noun)

**Delivery strategy**:
The policy that renders a **Delivery** over a **Run Branch**'s settled history. Built-ins: `family-pr`, `stack`, `main`. A **Consumer** authors one through `createDelivery`, sibling to `createTrackerAdapter` (ADR 0025). A strategy reconciles desired published state — it finds its artifacts by names derived from **Tracker** identity, never blind actions keyed on **Run** identity — and receives the repo, the **Landing** facts, the **Tracker** read, and the forge.
_Avoid_: mode (that is the `--mode` flag naming one), plugin, SDK

**Worktree**:
The directory a **Worker** runs in; one per **Ticket**, on that **Ticket**’s **Branch**. Disposable: the **Branch** carries the work forward, not the directory.
_Avoid_: clone, cwd mode, workspace (somewhere the **Consumer** continues by hand)

**Doctor**:
The check that config — and any named **Root** — matches the **Tracker**. A **Run** will not start if it fails. It takes the same root flags as `run`, plus the base gate's escape (`--allow-stale-base`).
_Avoid_: lint (SpeechDeck’s word), validate

**Init**:
The command that writes a stub `readyrun.config.ts` in the **Consumer** root. Interactive by default (Clack); scriptable with `--answers <file>` so CI or a template-repo setup script can drive it without a TTY. It does not assemble `run`. It also makes sure the **Consumer**'s `.gitignore` covers `.readyrun/`, the directory `run` creates **Worktrees** under, so a **Consumer** never has to add that line by hand. The stub it writes is one a **Run** can use as-is: **Permissions** `"unattended"`, and `contextFile: "GLOSSARY.md"` when the **Consumer** root already has that file.
_Avoid_: setup-ralph, generated `ralph/` folder, command wizard

**Launcher**:
The Clack surface bare `readyrun` opens on a TTY; off a TTY, bare `readyrun` is usage. Its first question names what to assemble — a **Run** or a **Delivery**; a decline ends a success (ADR 0043). Assembling a **Run**, it collects answers — naming the **Root** among them by rendering the **Tree**, where picking **Tickets** emits the explicit list and taking the **Frontier** from the top names none, and a picked waiting **Ticket** is confirmed before it lands in the **Root** — renders the **Plan**, and on confirm hands the terminal to the **Run**'s own renderer. Assembling a **Delivery**, it collects the **Delivery strategy** and the **Run Branch** — listed from the `readyrun/run-` namespace, never guessed — renders the **Delivery**'s **Plan**, and hands off to the same renderer. Everything it collects is flag-expressible; it never re-derives **Doctor**'s rules; it is never a prompt inside a **Run**, and an unattended **Run** never prompts.
_Avoid_: wizard, menu, TUI shell (around a live **Run**)

**Consumer**:
A repo that depends on the package and supplies `defineConfig`. SpeechDeck (GitHub) and Trackunit (Linear) are the two v0 **Consumers**.
_Avoid_: host, target repo (as a noun)

**Plan**:
What a **Run** resolves before its first side effect: **Doctor**'s verdict, the **Frontier** in pick order, the resolved base, the **Run Branch** it collects onto, the resolved cap, which **Tickets** wait off the **Frontier**, and — best-effort — any **Frontier** **Ticket** whose blocker has left the **Frontier** without its merge marker reaching the resolved base. A **Delivery** resolves its own **Plan** the same way: what would be pushed, which PRs opened, and on which bases. Computed once and rendered read-only: `run --preview` is its opt-in stdout rendering, and run-start disclosure is the always-on one. A surface that assembles a **Run** renders the **Plan**; it never re-derives **Doctor**'s rules, and the **Run** consumes the **Plan** rather than resolving again.
_Avoid_: dry run, simulation, plan mode, wizard output

**Run**:
One invocation of the loop, from start until the **Frontier** is empty, the cap is hit, or a hard stop.
_Avoid_: session, job, sprint

**Permissions**:
How freely a **Worker** may act without asking. `"ask"` or `"unattended"`. Default `"ask"`. The print-mode Adapters (`cursor()`, `claude()`, `opencode()`) make ask a **Doctor** failure — pass `"unattended"`. Vendor flags (`--yolo`, `--auto`, `--dangerously-skip-permissions`) stay inside the **Worker Adapter**.
_Avoid_: yolo, autoApprove, boolean `yolo`

**Effort**:
How hard a **Worker** thinks on a **Ticket**. `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"` on the **Run**; the **Worker Adapter** declares which of those it can honestly map — Claude's `--effort` takes all five, `custom()` declares its own explicitly, opencode maps `--variant` and (the values being provider-specific) declares only `high` | `max` until a **Consumer**'s trial corrects it, and Cursor takes effort as a model variant, not a flag, so it declares none. Effort outside the Adapter's declared vocabulary is a config lie **Doctor** fails, and the **Launcher** only offers declared values.
_Avoid_: max mode (Cursor's interactive slash command), ultracode (a Claude Code workflow setting)

## Relationships

- One **Consumer** config selects one **Tracker**. A repo is not GitHub-and-Linear at once.
- A **Tracker Adapter** talks to exactly one kind of **Tracker**. GitHub and Linear are both v0 **Tracker Adapters**.
- A **Worker Adapter** talks to exactly one kind of coding CLI. v0 ships `cursor`, `claude`, `opencode`, and `custom` (`bin` + args). Codex is later.
- The package is published (JSR and npm, always the same version) and depended on. It does not live inside a **Consumer**.
- If the chosen **Tracker** cannot be reached, the loop does not invent another **Tracker**. A local **Tracker Adapter** is a future option a **Consumer** would select on purpose.
- One **Ticket** is one **Worker**. The loop never gives two **Tickets** to one process.
- A parent id or a label query names a **Frontier**. It is not a **Ticket**.
- A **Frontier** is the **Tracker Adapter**’s answer to: `ready: "unblocked"` (string literal), plus a Consumer selector (GitHub labels, Linear state/label/project), plus an optional root (a parent id or an explicit list of **Ticket** ids), named on the command line per **Run**. The **Ticket** body does not name the **Frontier**.
- When more than one **Ticket** is on the **Frontier**, pick order is the **Tracker Adapter**’s stable order (GitHub: issue number ascending). There is no priority field on the **Ticket**. Naming **Tickets** does not sequence them — command-line order is not pick order; a blocking relationship is.
- When a **Worker** starts, the harness creates a **Branch** for that **Ticket**. It does not start on main. The **Ticket** body does not name the **Branch**; a **Tracker**'s own suggested name is a fact the **Tracker Adapter** reads onto the answer, not authoring.
- Each **Worker** runs in a **Worktree** on that **Branch**, even when a **Run** is serial. There is no cwd-isolation mode and no clone-per-**Ticket**.
- A **Worker** is anchored to its **Worktree** by its **Worker Adapter**'s argv — a `{cwd}` placeholder interpolated at spawn — never by process cwd alone, because a CLI that re-roots linked worktrees resolves cwd to the git common dir and never sees the **Worktree** at all. The **Worker** prompt names the **Worktree**'s absolute path and the **Ticket**'s **Branch**; "this directory" is not an instruction (ADR 0036).
- A **Run** treats work that appeared outside the **Ticket**'s **Worktree** and **Branch** as a failed **Ticket**: repo-global state is snapshotted before each **Worker** and diffed after, and the hard stop names what moved instead of saying the **Ticket** produced nothing. **Doctor** proves a **Worker Adapter**'s cwd fidelity in a throwaway **Worktree** before a **Run** starts, so an Adapter that re-roots linked worktrees is caught before it can lose a **Ticket** (ADR 0037).
- A **Run** names one **Run Branch**, starting from whatever the **Consumer**'s checkout was on when the **Run** started. The ref is created at the first successful merge; a **Run** that lands no **Tickets** leaves no **Run Branch** ref. Each **Ticket**'s **Branch** starts from the **Run Branch**'s tip as at the moment that **Ticket** was picked — never from another **Ticket**'s **Branch**. Before any merge, that tip is the base the **Run** resolved at start. Hitting the cap ends that **Run**. A later **Run** that continues from it is a new **Run** with a new **Run Branch**; its base can be the previous **Run Branch**'s tip. That is not the first **Run** un-ending, and it is not one long-lived integration branch.
- A **Run**'s base is the **Consumer**'s checkout unless `--base <commit-ish>` names another, which leaves the primary checkout where the **Consumer** left it rather than parking it on a `readyrun/` ref. Continuing a capped **Run** is that flag pointed at the previous **Run Branch**; the flag is not otherwise about resuming, because any commit-ish is a legitimate base.
- When a **Worker** succeeds, its **Ticket**'s **Branch** is merged into the **Run Branch** as exactly one merge commit — never fast-forwarded, never squashed — and is then deleted. One **Ticket** is therefore one entry in the **Run Branch**'s first-parent history, with the **Worker**'s own commits kept underneath it. The next **Ticket** starts from a tree containing every **Ticket** the **Run** has already finished.
- A **Run** never merges its **Run Branch** anywhere and never pushes it. A **Run Branch** is local to the machine that ran the **Run**, and what becomes of it — by hand, or as a **Delivery** — is the **Consumer**'s.
- A **Run** ends by saying where the work is: how many **Tickets** landed, whether the **Run Branch** ref exists, the base it was cut from, and whether it stopped on an empty **Frontier** or the cap. It does not tell the **Consumer** to push or merge, because integration is not its to recommend. A **Run** that stopped on the cap does name the command that continues from the **Run Branch** it just built, because ReadyRun's own next invocation is its to recommend in a way a git workflow is not. When a family's **Tickets** have all landed, the report may likewise name `deliver` — ReadyRun's own next invocation — but never runs it. When a **Ticket** leaves the **Frontier** it is told the same thing — the **Run Branch**, the merge commit, and that the ref is local — so the reviewer is not left reading a **Ticket** that points nowhere.
- A **Worker** commits its own work; ReadyRun never writes a commit that describes code. The only commit it makes is the merge of a **Ticket**'s **Branch** into the **Run Branch**, and that message is derived from the **Ticket** exactly as the **Branch** name is. A **Worker** that exits 0 leaving its **Worktree** dirty, or its **Branch**'s tree matching the base it was cut from, has failed.
- A **Worktree** is removed once its **Worker** succeeds and kept when the **Run** hard-stops, so a failure is still there to look at. The **Run Branch** outlives both.
- A **Hard stop** leaves the **Run Branch** as it stands when that ref exists: **Tickets** already merged stay; the failed **Ticket** does not. If nothing has merged, there is no **Run Branch** ref — that **Run** produced nothing to review. One stop is the exception to reading the remaining **Frontier** as exactly the unfinished work: a **Tracker** failure at the last step of a **Ticket** — after its merge succeeded — leaves a landed **Ticket** on the **Frontier**, and that hard stop's report names the **Ticket**, the merge commit, and the manual step of taking it off by hand before continuing (ADR 0049). The merge stage answers to the same policy from the other side: the **Worktree** is already removed when the merge fails, so there is no **Worktree** to keep and nothing landed — that hard stop's report names the **Ticket**'s surviving **Branch**, where the **Worker**'s commits sit, and the manual step of recovering or deleting it before the **Ticket** can be picked again (ADR 0049).
- A **Run** (and **Doctor**) refuse to start if config or the command line lies about the **Frontier**: missing labels, repo ≠ remote, `unblocked` claimed but the **Tracker** cannot say so, unknown keys, a named **Ticket** that can never join the **Frontier** (nonexistent, closed, a duplicate, outside the root), a root for a **Tracker Adapter** that cannot read parents. A named **Ticket** that is merely blocked is waiting work, not a lie: warn, and it joins when its blocker clears mid-**Run**. Unused knobs (a label map with no matching **Tickets**) warn. The check is once at **Run** start, not every iteration.
- A **Run** (and **Doctor**) also refuse to start if the **Consumer** has a lockfile whose install output is neither tracked nor ignored: ReadyRun would create that dirt itself, and every **Ticket** would then hard-stop as if the **Worker** left work uncommitted. A **Consumer** that already ignores it is unchanged.
- Before a **Ticket** is claimed, a **Run** discloses the base commit it resolved and the **Run Branch** it will collect onto, calls out a base that is not the default branch, and warns when the primary checkout is dirty, because uncommitted changes there reach no **Worktree**. It also names the HEAD trap: when HEAD stands on a branch in the `readyrun/run-` namespace the default branch does not contain — membership there being what makes it a **Run Branch** — it says so and points at `--base` from the default branch, because a Run with no `--base` there would cut a new **Run Branch** from a parked ref. **Doctor** discloses the same base and names no **Run Branch**, because it creates none. The base is also probed once at start for freshness: one read-only `git ls-remote` compares the resolved base against origin's tip of the default branch — stale meaning the base does not contain that tip, fresh and ahead silent, a behind-count best-effort naming, an unreachable probe a warning, and no `origin` or a detached HEAD silent. This is disclosure, not a gate: starting from a feature branch on purpose is legitimate — with one exception, when no `--base` was named and HEAD stands stale on the default branch, the one case that stops a **Run** — and **Doctor** with it — until `--allow-stale-base` says otherwise; a base named by `--base` is warned, never gated (ADR 0046).
- The **Plan** also discloses, best-effort and warning-only, any **Frontier** **Ticket** the **Tracker** calls unblocked whose blocker has left the **Frontier** without its merge marker reaching the resolved base's first-parent history: `unblocked` is the **Tracker**'s **Frontier** transition and says nothing about the base (ADR 0016), so the disclosure speaks in marker terms — the **Tracker** says unblocked; the base does not contain the marker — never work terms, because a marker absent is a question, not an answer (a squash, a family **Delivery**, and a human-implemented blocker leave none). A marker found is work found. It is computed once with the **Plan** and rendered by **Run** start, the preview, and **Doctor**; it never gates, never skips, and is silent where the history cannot be read (ADR 0050).
- When a **Worker Adapter** defines a probe, **Doctor** runs it once the binary is confirmed to exist, and a probe failure is reported distinctly from a missing binary. A **Worker Adapter** with no probe (`custom` today) keeps the existence-only check unchanged.
- **ReadyRun** loads one `readyrun.config.ts` (same basename, JS/MJS allowed) at the **Consumer** root. **Init** writes that stub. There is no generated scripts folder and no search through other config filenames.
- The stub **Init** writes sets **Permissions** `"unattended"` and, when the **Consumer** root already holds a `GLOSSARY.md`, points `contextFile` at it. Neither is a Clack question: ask cannot reach a **Consumer** through print-mode, and the context file is either already there or it is not. **Init** asks only what it cannot see.
- **Init** is interactive by default (Clack), and `--answers <file>` is the scriptable path through the same writer. The **Launcher** is the second Clack surface: bare `readyrun` opens it on a TTY and prints usage off one. It collects answers, renders the **Plan** — the **Run**'s, or the **Delivery**'s — and on confirm hands the terminal to the same renderer; it is not a prompt inside a **Run**. `run`, `doctor`, and `deliver` are flags plus stdout. A **Run** owns the terminal while a **Worker** runs: it renders the **Worker**'s stream — one annotated line per tool call (kind glyph + verb + target), tool results silent unless failed, narration passed through, unknown output never silently dropped — under one glyph taxonomy shared with the Run's own lines (picked, landed, stopped, warned). On a TTY a spinner (glyph + elapsed since the **Ticket** started) shows between prints, and `--verbose` bypasses rendering for the raw stream; off a TTY the same render is newline-delimited lines with no animation, and the stage heartbeat (Doctor, Frontier, Worktree, Worker) and in-flight **Ticket** line (id, title, branch, started/cap) are unchanged. The **Launcher** assembles `run` and `deliver`, and nothing else does; everything it collects is flag-expressible, and it never re-derives **Doctor**'s rules. An unattended **Run** must not prompt.
- A **Run** cannot start without a cap: a maximum number of **Tickets** it may start. The cap resolves `--max`, then config `cap`, then — for an explicit list — the list’s length, so a single-**Ticket** invocation is a **Run** with cap 1. Hitting the cap stops the **Run**; it does not prompt; a list longer than the cap keeps its remainder on the **Frontier**. There is no unlimited **Run**.
- A v0 **Run** starts one **Worker** at a time. That is behaviour, not the isolation model: a **Worker** is already one **Ticket**, one **Branch**, one **Worktree**, so concurrency later is a knob, not a rewrite.
- **Permissions** are first-class on the **Run**: `"ask"` or `"unattended"`. Default `"ask"`. Never implied by looping. The **Worker Adapter** maps `"unattended"` to its flag; `custom` is told the flag. The print-mode Adapters spawn print-mode (`cursor()` and `claude()` as `-p`, `opencode()` as `run`); ask has nowhere to go, so **Doctor** (and a **Run**) refuse it and name `--permissions unattended`. Sandbox-bypass is not a third value in v0.
- **Effort** is first-class on the **Run**: optional config default, CLI `--effort` for this **Run**. The **Worker Adapter** declares the vocabulary it maps — `--effort` for Claude, `--variant` (`high` | `max`) for opencode; Cursor does not — pick a model variant instead. **Doctor** fails Effort set outside the Adapter's declared vocabulary. Not authored on the **Ticket**.
- A **Worker**’s model: config default is required (**Doctor** fail if missing). CLI `--model` overrides that default for the **Run**. A label map may override per **Ticket**. The **Ticket** body does not name a model.
- The **Worker** prompt is owned by the package: loop rules plus **Tracker Adapter** copy (this **Ticket**’s id, title, body, URL). Loop rules tell the **Worker** it will not get a reply and must not ask the **Consumer**; a blocking question is a failed **Ticket**, not a pause. A **Consumer** may append a repo context file from config. That file does not replace tracker instructions. There is no repo `prompt.md` that owns the loop.
- When a **Worker** succeeds, the **Ticket** must leave the **Frontier**. The **Tracker Adapter** has a default for that (Linear: In Review, not Done; GitHub: drop the frontier label, comment, do not close). A **Consumer** may override; they do not have to write a hook.
- A **Run** hard-stops (no skip, no retry-forever) on **Tracker** API or auth failure, **Branch**/**Worktree** failure, **Worker** missing or not logged in at spawn, **Worker** non-zero exit, a **Worker** that exits 0 leaving its **Worktree** dirty or its **Branch**'s tree matching the base it was cut from, or a **Worker** that worked outside its **Worktree** and **Branch**. Empty **Frontier** and cap are clean stops. The harness owns **Tracker** auth; the coding CLI owns its own login.

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
> **Dev:** "I dumped ten **Tickets** and two are blocked by the first. Do I order the list?"
> **Domain expert:** "No. Naming is not sequencing. Blocked **Tickets** wait off the **Frontier** and join when their blocker lands."
>
> **Dev:** "#53 and #57 are both unblocked. Which **Worker** starts?"
> **Domain expert:** "#53. GitHub number, lowest first. You don't put priority on the **Ticket**."
>
> **Dev:** "Where do I put the Linear vs GitHub paragraph?"
> **Domain expert:** "You don't. **Init** writes `readyrun.config.ts`. You pick the **Tracker Adapter** there. No `ralph/` folder."
>
> **Dev:** "Can I get a Clack menu that builds `readyrun run --max 5`?"
> **Domain expert:** "Yes — bare `readyrun` on a TTY is the **Launcher**. It shows the **Plan**, then hands the terminal to the **Run**. Off a TTY it is flags; unattended cannot ask you."
>
> **Dev:** "Can CI or an agent run **Init** without a TTY?"
> **Domain expert:** "Yes. Default is Clack. Pass `--answers` with the same shape the prompts collect. That does not make **Init** a `run` wizard."
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
> **Dev:** "cursor() defaults to ask, so the **Worker** will prompt me, right?"
> **Domain expert:** "No. `cursor()` and `claude()` spawn print-mode (`-p`), and `opencode()` spawns `run`. That is not a chat. **Doctor** fails unless you pass `"unattended"`."
>
> **Dev:** "Do I put `opus` on the GitHub issue?"
> **Domain expert:** "No. Default is in config. `--model` for this **Run**. A label map if this **Ticket**'s labels say so."
>
> **Dev:** "The **Worker** exited 1. Do we start #53?"
> **Domain expert:** "No. The **Run** stops. We don't skip, and we don't retry GitHub until it works."
>
> **Dev:** "The **Run** hard-stopped. Throw away the **Run Branch**?"
> **Domain expert:** "Only if nothing merged. **Tickets** that already landed are still on it. The failure is the one that didn't. If the first **Ticket** failed, there is no **Run Branch** ref yet."
>
> **Dev:** "Do I copy prompt.md and change Linear to GitHub?"
> **Domain expert:** "No. The package tells the **Worker** it's GitHub #52 because you picked that **Tracker Adapter**. You may append a repo context file for how to test. You don't author the loop."
>
> **Dev:** "A **Run** of ten **Tickets** leaves me ten **Branches** to merge by hand?"
> **Domain expert:** "No, one. Each **Ticket** still gets its own **Branch** to work on, because two **Workers** can't share one, but a finished **Branch** is merged into the **Run Branch** and deleted. You review the **Run Branch**."
>
> **Dev:** "So #57 sees what #52 built earlier in the same **Run**?"
> **Domain expert:** "Yes — #57's **Branch** is cut from the **Run Branch** tip, and #52 is already merged into it."
>
> **Dev:** "Cap of 2. I want three more. Same **Run**?"
> **Domain expert:** "No. Hitting the cap ended that **Run**. The next one is a new **Run** with a new **Run Branch**. Its base can be the **Run Branch** you just finished, so #57 still sees #52. That is not the first **Run** un-ending."
>
> **Dev:** "So do I check out that **Run Branch** first?"
> **Domain expert:** "No — pass it as `--base`. Checking it out parks you on a `readyrun/` ref you'll forget you're on. The cap stop prints the command, so you don't have to remember the timestamp."
>
> **Dev:** "Can it just ask me at the cap whether to keep going?"
> **Domain expert:** "No. **Init** can ask because you just pressed enter. The cap lands whenever the last **Worker** happens to finish, and nobody's there — a question would sit unanswered for an hour, and answering yes would mean the cap isn't a cap."
>
> **Dev:** "The **Worker** finished and its directory is gone. Where's my work?"
> **Domain expert:** "On the **Run Branch**. The **Worktree** was only where the **Worker** ran. If it had failed we'd have left the directory for you."
>
> **Dev:** "The **Run** finished. Where's my PR?"
> **Domain expert:** "There isn't one. The **Run Branch** is on your machine and nowhere else. The **Run** told you its name, how many **Tickets** are on it, and where it started; pushing it is yours."
>
> **Dev:** "I want the family as one PR. Does the **Run** do that?"
> **Domain expert:** "No. The **Run** ends. You run `readyrun deliver --mode family-pr` after it — that's a **Delivery**, and you opt into it."
>
> **Dev:** "So why does the **Ticket** name a branch my colleague can't fetch?"
> **Domain expert:** "Because it says so. It names the **Run Branch**, the merge commit, and that the ref is local to the machine that ran the **Run**. Naming it without that would read like a shared location."
>
> **Dev:** "The **Worker** exited 0 without changing anything. Clean finish?"
> **Domain expert:** "No, that's a hard stop. Exit 0 on a **Branch** whose tree matches the base it was cut from means it produced nothing, and we're not taking the **Ticket** off the **Frontier** for that."

## Flagged ambiguities

- **Product name** — resolved: **ReadyRun**. CLI `readyrun`. Not Ralph, not spur (PATH and category collision with two agent harnesses).
- **Issue vs Ticket** — resolved: **Ticket** is ours. “Issue” is GitHub’s and Linear’s word, used only inside a **Tracker Adapter**.
- **Adapter** — resolved: unqualified “Adapter” is not a glossary noun. **Tracker Adapter** and **Worker Adapter** are different jobs.
- **Local Adapter** — resolved: not v0; later it is a first-class **Tracker** option, never a fallback when GitHub or Linear fail.
- **Beads** — not in scope unless someone wants a git-native **Tracker**.
- **Worktree** — resolved: v0 uses a git **Worktree** per **Ticket**, even while serial. Not a clone. Not the **Consumer** cwd. Lifetime resolved: disposable — removed once its **Worker** succeeds, kept when the **Run** hard-stops, and never a place the **Consumer** continues the **Ticket** by hand.
- **Branch** vs **Run Branch** — resolved: unqualified **Branch** is the **Ticket**'s. The **Run Branch** is always named in full. The ref is created at the first successful merge; naming one does not mean git has it yet.
- **Parallelism** — resolved for v0 behaviour: serial. Not resolved as “forever serial.” The shape must make raising concurrency later easy.
- **How a Run Branch leaves the machine** — resolved: it does not — a **Run** pushes nothing and opens no pull request; it reports where the work is, on stdout and on the **Ticket**, and integration stays the **Consumer**'s. Previously flagged as "How a Ticket lands", which ADR 0028 had already answered. Narrowed by #175 (ADR 0048): **Delivery** is a separate command the **Consumer** opts into; the **Run** itself still delivers nothing.
- **Delivery** — resolved (2026-10, #175, ADR 0048): **Delivery** is what a **Consumer** makes of a settled **Landing**, rendered by `deliver` from a **Delivery strategy** (`--mode` names one). Built-ins `family-pr`, `stack`, `main`; report-only stays the default — every publication is opt-in by running `deliver`. Not integration, not a **Landing**, never visible inside a **Run**. Artifacts are reconciled by names derived from **Tracker** identity, so a retried `deliver` finishes its own half-done work. Deliver owns birth, the **Consumer** owns life: `--draft` and `--label` are creation options, never revisited afterwards — flipping draft to ready is the **Consumer**'s pipeline's act. A publication refuses when its diff would not be exactly what it claims (interleaved merges, unintegrated bases); `main` discloses instead of refusing.
- **Run stats** — unresolved. Token usage, context-window % across **Workers**, printed at the end of a **Run**. Wanted; not v0-blocking.
- **Automatic review** — resolved for v0: no. A review **Ticket** on the **Frontier** is just a **Ticket**. A second **Worker** that reviews the first is later.
- **Permissions** — resolved: `"ask"` | `"unattended"`. Default ask. Not yolo. Not a boolean. Print-mode (`cursor()`, `claude()`) cannot use ask.
- **Effort** — resolved: optional config default; CLI overrides the **Run**. The Adapter declares the vocabulary it maps (ADR 0042): `--effort` for Claude, explicit declaration for `custom`, `--variant` (`high` | `max`) for opencode. Cursor does not map the flag (model variants). **Doctor** fails out-of-vocabulary Effort. Not ultracode, not max-mode.
- **Model** — resolved: required config default; CLI overrides the **Run**; label map overrides per **Ticket**. Not authored on the **Ticket**.
- **Hard stop** — resolved: **Tracker**/git/**Worker** failure ends the **Run**. No skip, no retry-forever. Cap and empty **Frontier** are clean stops. Harness owns **Tracker** auth; CLI owns Worker login. **Tickets** already on the **Run Branch** stay; if none merged, there is no **Run Branch** ref.
- **Frontier at-least-once** — resolved (2026-10, #114, ADR 0049): the merge and `leaveFrontier` cannot be atomic, so exactly one stop leaves a landed **Ticket** on the **Frontier**; that hard stop's report names the **Landing** and the manual step. Detection at the next **Run** resolved (2026-10, #70, ADR 0050): a best-effort merge-marker disclosure in the **Plan**, never a gate, never a skip. Retry is #113.
- **Worker prompt** — resolved: package + **Tracker Adapter**. Optional Consumer context file. Not a repo-owned `prompt.md`.
- **Frontier query** — resolved: `ready: "unblocked"` + selector + optional root. Not parent-only, not labels without unblocked. Resolved further as a command-line root (#131): the explicit list bypasses the selector but never `unblocked`; the parent narrows and is never worked itself; naming is not sequencing (stable order holds, blocking sequences); the list's length is the cap floor; permanent lies refuse at start, waiting work warns and joins mid-**Run**.
- **Pick order** — resolved: stable **Tracker Adapter** order (GitHub: issue number ascending). No priority on the **Ticket**.
- **Config file** — resolved: `readyrun.config.ts` at the **Consumer** root. **Init** writes it. No `ralph/` scripts, no cosmiconfig.
- **Clack** — resolved twice. **Init** is interactive by default and `--answers` scripts it without a TTY. The **Launcher** is the second Clack surface (2026-09-20, #133): bare `readyrun` opens it on a TTY; it collects answers, renders the **Plan**, and hands the terminal to the **Run**'s own renderer. Deferred at ADR 0019, un-deferred when its premise changed — the product's only human user wants it — with ADR 0019's "Doctor would explain both" objection met by the **Plan**: one computation, two renderings, **Doctor** still the only rule-keeper (ADR 0039, ADR 0040). **Run** and **Doctor** liveness is stdout, not Clack; an unattended **Run** never prompts. Generalized 2026-10 (#175, ADR 0048): the **Launcher** assembles a **Run** or a **Delivery** — same ask-first, render-Plan, hand-off shape — and `deliver` off a TTY is flags.
- **Continue after a cap** — resolved: a new **Run** whose base can be the previous **Run Branch**'s tip, never the same **Run** un-ending, named by `--base <commit-ish>`. A **Run** does not prompt at the cap: **Init** asks the instant a **Consumer** types the command, whereas the cap is reached at an unpredictable moment with nobody there, so a question would hold the process open and a yes would make the cap unbounded. Not `--continue` or `--from`: the base is already the project's word for this, and a most-recent heuristic would let ReadyRun pick the wrong tree itself.
- **Worker output on the terminal** — resolved: a **Run** renders the **Worker**'s stream instead of inheriting the terminal (ADR 0035). One glyph taxonomy covers the **Worker**'s activity and the Run's own lines. `--verbose` is raw passthrough. `custom()` without a `format` streams raw between the Run's lines. Transcript recording stays #122.
- **Worker escape** — resolved: a **Worker** works its **Worktree** or nowhere. The Adapter's argv pins it (ADR 0036); escape is detected, not assumed — **Doctor** probes cwd fidelity before a **Run**, and the postcheck diffs repo-global state after each **Worker**, naming what moved (ADR 0037). The incident that decided this is #125.
- **Base freshness** — resolved: one read-only probe at **Run** start compares the resolved base against origin's tip of the default branch; stale is the base not containing that tip. Fresh and ahead are silent, a behind-count is best-effort naming, an unreachable probe warns, and no `origin` or a detached HEAD skips silently. It gates only the unnamed case — no `--base`, stale HEAD on the default branch — behind `--allow-stale-base`; a base named by `--base` is warned, never gated. Tell, don't touch: never fetched, never fast-forwarded (ADR 0046).
- **Blocked on sequencing** — resolved (2026-10, #70, ADR 0050): not a second blocking vocabulary. The **Tracker** owns the blocking relation, and `unblocked` stays the **Frontier** transition; when the **Tracker** says unblocked and the resolved base lacks a left-the-**Frontier** blocker's merge marker, the **Plan** discloses exactly that in marker terms. The distinction between blocked on code and blocked on sequencing is read out of the disclosure's wording, never configured.
