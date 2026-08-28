# ReadyRun

A TypeScript CLI that walks a tracker **Frontier** and runs one coding **Worker** per **Ticket**, in a fresh process, on its own **Branch** and **Worktree**.

This repo is the product. It is not SpeechDeck. SpeechDeck (and later Trackunit) will *depend* on it.

v0 is specced, not implemented. Spec: [`docs/specs/readyrun-v0.md`](./docs/specs/readyrun-v0.md). Language: [`CONTEXT.md`](./CONTEXT.md). Decisions: [`docs/adr/`](./docs/adr/).

```sh
readyrun init
readyrun doctor
readyrun run --max 5
```

Package: JSR, once it exists. Config in the consumer: `readyrun.config.ts`.
