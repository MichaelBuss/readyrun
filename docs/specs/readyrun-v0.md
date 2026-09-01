# ReadyRun v0

Vocabulary in this document is the glossary in [`CONTEXT.md`](../../CONTEXT.md). Decisions it rests on are [`docs/adr/`](../adr/) 0001–0021.

## Problem Statement

I have a queue of ready work — SpeechDeck's implementation tickets on GitHub, and (at work) tickets in Linear — and I want them implemented one after another without starting each one by hand. Every option available today costs me something.

Driving each ticket myself means I sit with it. A single long agent session that eats several tickets rots: the context window fills with the previous ticket and quality falls off, so one ticket has to mean one fresh process. Ralph's answer is a `ralph/` folder copied into every repo, where the issue source is a flag and the tracker instructions are a paragraph in `prompt.md` that I hand-edit from Linear to GitHub per repo. Tools that go further replace my tracker with a database of their own, so the queue stops being the issues my team can see. And anything that loops without a bound can quietly run up an arbitrary bill while I am away from the desk.

What I want is Ralph's loop with a real configuration API: the varying parts (which tracker, which coding CLI, which tickets count as ready, which model) declared once per repo, and the instructions that tell a worker "this is GitHub #52" shipped in the package because I selected the GitHub adapter — not written by me, again, in this repo's prompt file.

## Solution

**ReadyRun** is a TypeScript CLI, published to JSR, that a repo depends on. A **Consumer** writes one `readyrun.config.ts` at its root declaring its **Tracker** (GitHub or Linear), its **Worker Adapter** (Cursor, Claude, or a custom binary), and how to name its **Frontier**.

**Init** is an interactive prompt that writes that stub. **Doctor** checks the config against the real **Tracker** and tells me which **Ticket** the repo will take next, refusing when the config describes a **Frontier** that does not exist. **Run** walks the Frontier: it picks the next ready **Ticket**, creates a **Branch** and a **Worktree** for it, spawns a **Worker** with a fresh context window, and — when that Worker succeeds — updates the **Ticket** so it leaves the Frontier. Then it picks again, until the Frontier is empty or the required cap is reached.

A Run cannot start without a cap on how many Tickets it may start, so an unattended loop has a known worst case. **Permissions** are declared, never inferred: looping does not mean the Worker may act unsupervised. Any real failure — the Tracker unreachable, git refusing, the Worker exiting non-zero — ends the Run rather than skipping ahead or retrying forever.

## User Stories

### Setting a repo up

1. As a repo maintainer, I want to add ReadyRun as a dependency from JSR, so that I do not copy loop scripts between my repos.
2. As a repo maintainer, I want `readyrun init` to ask me a few questions and write a config stub, so that I do not start from a blank file.
3. As a repo maintainer, I want `init` to offer GitHub or Linear as the **Tracker**, so that the same tool serves my personal repo and my work repo.
4. As a repo maintainer, I want `init` to offer Cursor, Claude, or a custom binary as the **Worker Adapter**, so that I am not forced onto the vendor I dogfood with.
5. As a repo maintainer, I want exactly one config file at a known name, so that I always know which file **Doctor** is talking about.
6. As a repo maintainer, I want unknown config keys to be an error, so that a typo is not silently ignored.
7. As a repo maintainer, I want config to be TypeScript with typed helper factories, so that my editor tells me what a **Tracker Adapter** accepts.
8. As a repo maintainer, I want no generated scripts folder in my repo, so that upgrading ReadyRun does not mean re-copying files and re-applying my edits.
9. As a repo maintainer, I want to optionally point at a repo context file, so that a **Worker** learns how to run this project's tests without that living in every **Ticket** body.

### Checking the setup

10. As a repo maintainer, I want `readyrun doctor` to tell me which **Ticket** the repo will take next, so that I can trust what an unattended **Run** is about to do.
11. As a repo maintainer, I want **Doctor** to fail when a label named in config does not exist on the **Tracker**, so that I do not start a **Run** whose **Frontier** is always empty.
12. As a repo maintainer, I want **Doctor** to fail when the repo in config is not the repo my git remote points at, so that I do not drive the wrong project's issues.
13. As a repo maintainer, I want **Doctor** to fail when I ask for unblocked ordering but the **Tracker** cannot express blocking, so that dependency order is never silently ignored.
14. As a repo maintainer, I want **Doctor** to fail when the configured **Worker** binary is missing, so that I find out before a Ticket is claimed rather than after.
15. As a repo maintainer, I want a warning — not a failure — when a by-label model override matches no **Tickets**, so that unused configuration does not block real work.
16. As a repo maintainer, I want the same checks to run automatically at the start of a **Run**, so that a stale config cannot burn the cap.
17. As a repo maintainer, I want those checks to run once at start rather than on every iteration, so that a long **Run** is not dominated by API chatter.

### Running the loop

18. As an operator, I want `readyrun run` to require a maximum number of **Tickets**, so that a loop I walk away from has a bounded cost.
19. As an operator, I want hitting that cap to stop the **Run** silently rather than prompt me, so that an unattended loop ends cleanly instead of hanging on a question.
20. As an operator, I want a single-**Ticket** invocation to be the same command with a cap of one, so that there is one code path to understand.
21. As an operator, I want the **Run** to stop when the **Frontier** is empty, so that "there is nothing ready" is a normal ending and not an error.
22. As an operator, I want each **Ticket** to get its own **Worker** process with a fresh context window, so that the fifth ticket is done as well as the first.
23. As an operator, I want one **Worker** at a time in v0, so that I can watch what is happening while the tool is young.
24. As an operator, I want the **Ticket** the **Worker** is given to be one Ticket, never a tree, so that scope does not drift into neighbouring work.
25. As an operator, I want live status on my terminal showing the current **Ticket**, how many of the cap are used, and the **Branch**, so that I can see progress at a glance.
26. As an operator, I want the process exit code to distinguish a clean finish from a hard stop, so that I can drive ReadyRun from a script.

### Choosing what runs next

27. As a repo maintainer, I want the **Frontier** to be defined as unblocked **Tickets** matching my selector, so that a blocked ticket is never picked.
28. As a repo maintainer, I want to select by GitHub label or by Linear state, label or project, so that each tracker is addressed in its own terms.
29. As a repo maintainer, I want to optionally narrow the **Frontier** to a parent's children or an explicit list of **Tickets**, so that I can run a slice of the backlog.
30. As a repo maintainer, I want readiness expressed as a named string rather than a boolean flag, so that the config reads as intent and can grow other values.
31. As a repo maintainer, I want pick order to be the **Tracker**'s own stable order, so that **Doctor**'s "next is #52" is the Ticket that actually runs.
32. As a repo maintainer, I want no priority field on the **Ticket** itself, so that using ReadyRun does not change how my team writes issues.
33. As a repo maintainer, I want the **Frontier** re-evaluated after each **Ticket**, so that work unblocked by the Ticket just finished becomes eligible within the same **Run**.

### Git isolation

34. As a repo maintainer, I want each **Ticket** to get its own **Branch** created by ReadyRun, so that I do not have to write a branch name on the issue.
35. As a repo maintainer, I want ReadyRun to refuse to run a **Worker** on my default branch, so that unattended work can never land directly on main.
36. As a repo maintainer, I want each **Worker** to run in its own **Worktree**, so that my primary checkout is untouched while the loop runs.
37. As a repo maintainer, I want that isolation to exist even while the loop is serial, so that raising concurrency later is a setting rather than a redesign.
38. As a repo maintainer, I want the **Branch** name derived from the **Ticket**'s identity, so that I can tell at a glance which branch belongs to which ticket.

### Telling the Worker what to do

39. As a repo maintainer, I want the loop and tracker instructions to ship inside the package, so that I never again hand-edit a prompt file to say GitHub instead of Linear.
40. As a repo maintainer, I want the **Worker** to be told this **Ticket**'s identifier, title, body and URL, so that it can read the full issue itself.
41. As a repo maintainer, I want my optional repo context appended rather than substituted, so that local facts are added without losing the loop's own rules.
42. As a repo maintainer, I want the **Worker** told never to invent a tracker or fabricate ticket state, so that a failed lookup surfaces instead of being imagined.
43. As a repo maintainer, I want the instructions to reflect the adapters I selected, so that a Linear repo is never told about issue numbers.

### Models and permissions

44. As a repo maintainer, I want a required default model in config, so that a **Run** is never ambiguous about what it will spend.
45. As an operator, I want a command-line model override for one **Run**, so that I can try a cheaper or stronger model without editing config.
46. As a repo maintainer, I want a by-label model map, so that review-shaped **Tickets** can use a different model from implementation ones.
47. As a repo maintainer, I want no model named in the **Ticket** body, so that routing is a repo decision rather than per-issue authoring.
47a. As a repo maintainer, I want an optional effort default in config, so that Claude and custom **Workers** think at a known level.
47b. As an operator, I want a command-line effort override for one **Run**, so that I can try a cheaper or deeper pass without editing config.
47c. As a repo maintainer on Cursor, I want effort to stay a model variant rather than a flag the **Worker** would reject.
48. As an operator, I want **Permissions** to be a named choice between asking and unattended, so that the setting reads as intent rather than as a vendor flag.
49. As an operator, I want asking to be the default, so that the first time I run ReadyRun I see what it wants to do.
50. As an operator, I want looping never to imply unattended, so that a long **Run** does not silently grant the **Worker** free rein.
51. As an operator, I want each **Worker Adapter** to know its own auto-approve flag, so that unattended means the same thing whichever coding CLI I picked.
52. As a repo maintainer using a custom binary, I want to declare that flag myself, so that an unsupported CLI still honours the same setting.
52a. As a repo maintainer, I want `cursor()` and `claude()` to accept extra static flags for the Worker binary, so that a vendor-specific setting does not force me to drop to `custom()`.

### Finishing a Ticket

53. As a repo maintainer, I want a successful **Ticket** to leave the **Frontier** automatically, so that the next iteration does not pick it again.
54. As a repo maintainer on Linear, I want a finished **Ticket** moved to In Review rather than Done, so that Done still means merged.
55. As a repo maintainer on GitHub, I want the frontier label dropped and a comment left rather than the issue closed, so that implemented is not confused with shipped.
56. As a repo maintainer, I want that behaviour built in rather than a hook I must write, so that a fresh **Consumer** is correct by default.
57. As a repo maintainer, I want to be able to override it, so that a team with different conventions is not blocked.

### When things go wrong

58. As an operator, I want a **Tracker** API or auth failure to stop the **Run**, so that the loop never proceeds on stale or invented state.
59. As an operator, I want a git failure creating the **Branch** or **Worktree** to stop the **Run**, so that a **Worker** never runs in the wrong place.
60. As an operator, I want a **Worker** exiting non-zero to stop the **Run**, so that a broken ticket is not buried under later work.
61. As an operator, I want no automatic retries, so that a flapping API cannot loop until the cap is gone.
62. As an operator, I want no automatic skipping, so that failures are visible at the top of my terminal rather than in the middle.
63. As an operator, I want the stop to say which **Ticket** and which stage failed, so that I know where to look.
64. As an operator, I want ReadyRun to own **Tracker** authentication while the coding CLI owns its own login, so that responsibility for credentials is unambiguous.

### Interacting with the tool

65. As an operator, I want the interactive prompts confined to `init`, so that the command I actually repeat is plain flags I can put in a script.
66. As an operator, I want no wizard in front of `run`, so that there is exactly one way to express a **Run** and unattended mode is not a special case.
67. As an operator, I want bare `readyrun` to print usage rather than open a menu, so that the tool behaves like the other CLIs in my terminal.

## Implementation Decisions

### Shape and distribution

- ReadyRun is its own repo and its own JSR package. It does not live inside a **Consumer**, and SpeechDeck is a consumer of it rather than its home (ADR 0001). It is not published to npmjs.com; a **Consumer** still installs with npm/pnpm/yarn through JSR’s compatibility layer. The CLI is the `cli` export, run as a program — JSR does not put `readyrun` on PATH (ADR 0020).
- The public surface is a `defineConfig` function plus adapter factory functions. A **Consumer** selects one **Tracker Adapter** and one **Worker Adapter** by calling the corresponding factory. Unknown keys are rejected rather than ignored (ADR 0009, 0018).
- Config lives in one `readyrun.config.ts` at the Consumer root, with JS and MJS accepted under the same basename. There is no search across candidate filenames and no generated scripts directory (ADR 0018).
- The product name is ReadyRun and the binary is `readyrun`. Spur was rejected after a collision check found two existing agent harnesses shipping a `spur` binary (ADR 0015).

### Modules

- **Loop** — fixed behaviour, not configurable: evaluate the **Frontier**, pick, prepare git, spawn, finish, repeat until the Frontier is empty, the cap is reached, or a hard stop fires.
- **Tracker Adapter** — maps one tracker's issues onto **Tickets**, answers the **Frontier** query, and applies the finish transition. GitHub and Linear both ship in v0 because there are two real consumers today (ADR 0001). The word "issue" appears only inside this module; everywhere else the noun is **Ticket** (ADR 0003).
- **Worker Adapter** — spawns one coding CLI: prompt, model, working directory, and the mapping from **Permissions** to that vendor's flag. v0 ships Cursor, Claude, and a custom adapter taking a binary and arguments. Codex is deliberately later. It does not own the CLI's authentication and is not a vendor SDK (ADR 0010).
- **CLI** — `init`, `doctor`, `run`, parsing flags into the same options object the programmatic entry takes.
- The two adapter kinds are distinct concepts and are always named in full; unqualified "adapter" is not part of the vocabulary (ADR 0010).

### The Frontier

- A **Frontier** is the Tracker Adapter's answer to a readiness value of `unblocked`, a Consumer selector (GitHub labels; Linear state, label or project), and an optional root that is either a parent identifier or an explicit list of Ticket identifiers (ADR 0016).
- Readiness is a named string rather than a boolean, matching the standing preference for string literals over flags.
- Pick order is the Tracker Adapter's stable order — for GitHub, ascending issue number. There is no configurable sort and no priority field on the Ticket, so **Doctor**'s prediction and the Run's behaviour cannot disagree (ADR 0017).
- The Frontier is recomputed between Tickets so that work unblocked by the Ticket just completed becomes eligible in the same Run.

### The Run

- A Run requires a maximum number of Tickets it may start. The unit is Tickets started, not wall-clock and not dollars, and not the Worker's internal turn limit — that may still be passed through to the coding CLI. There is no unlimited Run; a one-shot invocation is a Run with a cap of one (ADR 0005).
- Reaching the cap stops the Run without prompting.
- v0 starts one Worker at a time. Concurrency is deliberately a later setting rather than a redesign, which is why isolation is already per-Ticket (ADR 0007).
- Live status is written to standard output. Interactive prompting exists only in `init`; there is no wizard that assembles a `run` invocation, because every flag would then exist twice and an unattended Run cannot prompt (ADR 0019).

### Git

- When a Worker starts, ReadyRun creates a **Branch** for that Ticket, with the name derived from the Ticket's identity — Linear's suggested branch name where the adapter can read it, otherwise a convention over the identifier. The Ticket body never names the branch (ADR 0004).
- ReadyRun refuses to start a Worker on the default branch.
- Each Worker runs in a git **Worktree** on that Branch. There is no mode that checks out in the Consumer's working directory, and no clone-per-Ticket: the first makes concurrency a rewrite, the second is slower with no current use (ADR 0008).
- Worktree lifetime, pushing, and integration are explicitly not decided here.

### Permissions and models

- **Permissions** is a Run-level value of `ask` or `unattended`, defaulting to `ask`. Looping never implies unattended. Each Worker Adapter maps `unattended` onto its own auto-approve flag; the custom adapter is told which flag to use. Sandbox bypass is not a third value in v0 (ADR 0011).
- Model resolution is: a required config default, overridden by a command-line model for the whole Run, overridden by a by-label map for an individual Ticket. Doctor fails when the default is missing. The Ticket body never names a model (ADR 0012).
- **Effort** is an optional config default (`low` | `medium` | `high` | `xhigh` | `max`), overridden by `--effort` for the Run. The Worker Adapter maps it onto `--effort`. Cursor does not take that flag; Doctor fails if effort is set on an adapter that does not map it (ADR 0021).
- `cursor()` and `claude()` accept an optional `extraArgs: string[]`, landing between `-p` and `--model` — the same position `custom()`'s own `args` already occupy relative to `--model`. `custom()`'s `args` behaviour is unchanged (ADR 0022).

### The Worker prompt

- Loop rules and tracker-specific instructions ship in the package and are populated by the selected Tracker Adapter with the Ticket's identifier, title, body and URL (ADR 0014).
- A Consumer may name a repo context file whose contents are appended. It cannot replace the loop or tracker instructions — that was the Ralph prompt file this product exists to remove.
- The instructions include hard stops: do not invent a tracker, do not fabricate Ticket state, and do not retry a failed tracker call in a loop.

### Finishing and failing

- A successful Worker must leave its Ticket ineligible for the Frontier, or the next iteration picks it again. The Tracker Adapter carries that default: Linear moves to In Review and never Done; GitHub drops the frontier label, comments, and does not close. A Consumer may override, but no Consumer is required to write a hook (ADR 0006).
- A Tracker API or auth failure, a git failure, a missing or unauthenticated Worker binary at spawn, and a non-zero Worker exit all stop the Run. There is no skip and no retry-with-backoff, because skipping needs a new Frontier state and retrying needs a second cap. An empty Frontier and a reached cap are clean stops, distinguished from failures by exit code (ADR 0013).
- ReadyRun authenticates to the Tracker; the coding CLI owns its own login. Doctor checks what it can before anything is claimed.

### Doctor and Init

- Doctor and the start of a Run share one check. Anything that makes the Frontier a lie is fatal: unknown keys, a missing label, a configured repository that is not the git remote, unblocked ordering the Tracker cannot express, a missing Worker binary, a missing model default, effort set on an adapter that does not map it. Unused routing warns. The check runs once at start rather than per iteration (ADR 0009).
- Doctor also reports the Ticket that would be picked next.
- Init is the single interactive surface: it asks for tracker, worker and frontier selector, then writes the config stub (ADR 0019).

## Testing Decisions

A good test here asserts what a Consumer can observe — which Tickets ran and in what order, what the Tracker was asked to change, whether a Branch and Worktree existed, what was printed, and the exit code. It does not reach into how the Loop stores its state or how many times an internal function was called, because every one of those is something we should be free to change.

**The seam is the public config surface.** Tests assemble the same configuration object a Consumer writes, substituting a fake Tracker Adapter holding in-memory Tickets with labels and blocking edges, and a fake Worker Adapter that records what it was spawned with and returns a scripted exit code. They then invoke the same entry point the CLI invokes. This is the highest available seam and the only one a Consumer has, and every decision above is expressible through it: the cap, serial execution, pick order, refusal to start on the default branch, the finish transition, hard stops, permission mapping, model resolution, and the composed prompt.

**Git is real.** Each test that touches git runs against a throwaway repository created for it. "Never starts on the default branch" and "one Worktree per Ticket" are promises about git itself, and a faked git would only prove the fake behaves as written.

**Both real Tracker Adapters run one shared contract suite.** The suite is written once against the Tracker Adapter interface and covers Frontier evaluation, blocking, stable ordering, and the finish transition. The in-memory fake must pass it, so the fake used elsewhere cannot drift from real behaviour. GitHub and Linear pass it against recorded HTTP fixtures in normal runs, with live credentialed runs available opt-in.

**The CLI is tested as flag translation.** Given arguments, assert the options object handed to the same entry point, including that a Run without a cap is refused and that permissions default to asking.

**Init is tested as a writer, not as prompts.** Given a set of answers, assert the config stub produced, and assert that the stub it writes passes Doctor's key validation. The Clack rendering itself is not under test.

There is no prior art in this repo — it currently contains only the glossary and ADRs — so the first implementation ticket establishes the harness that later tickets extend.

## Out of Scope

The following are parked deliberately and tracked as `needs-refinement` issues. None is part of v0, and none should be pulled into the implementation queue without another grilling session:

- How a Ticket lands — pushing for review versus staying local, and how work is eventually integrated ([#1](https://github.com/MichaelBuss/readyrun/issues/1)).
- A second Worker that reviews the first ([#2](https://github.com/MichaelBuss/readyrun/issues/2)). A review-shaped Ticket on the Frontier is just a Ticket; by-label model routing is not automatic review.
- End-of-Run statistics such as token usage and context-window consumption ([#3](https://github.com/MichaelBuss/readyrun/issues/3)).
- Worktree lifetime and cleanup ([#4](https://github.com/MichaelBuss/readyrun/issues/4)).
- Raising Run concurrency, including claiming a Ticket so two Workers cannot pick the same one ([#5](https://github.com/MichaelBuss/readyrun/issues/5)).
- A local Tracker Adapter, as a first-class option a Consumer selects and never as a fallback when GitHub or Linear is unreachable ([#6](https://github.com/MichaelBuss/readyrun/issues/6)).
- A Codex Worker Adapter ([#7](https://github.com/MichaelBuss/readyrun/issues/7)).

Also out of scope: opening pull requests, merging anything, a terminal UI beyond printed status, a plugin system, multi-repo runs, and any behaviour that would make ReadyRun the owner of the queue rather than the Tracker.

## Further Notes

The two v0 Consumers are SpeechDeck on GitHub — whose implementation tickets already use a frontier label and native blocking — and, later, a work repository on Linear. Having both from the start is the reason both adapters ship in v0 rather than one: the second adapter is exactly the copy-paste this product exists to prevent.

SpeechDeck's standing workspace rule is that nothing is committed or pushed to the default branch. ReadyRun's refusal to run a Worker on the default branch is the mechanical form of that rule, and no v0 behaviour merges anything.

This spec is synthesis of a grilling session, not an implementation plan. Breaking it into tracer-bullet tickets is the next step, and those tickets should hang off this document rather than off the ADRs.
