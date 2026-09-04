import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker } from "../src/testing/mod.ts";
import { createWorkerAdapter } from "../src/worker-adapter.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { commitWorkerWork, throwawayRepo } from "./throwaway-repo.ts";

// A Worker inherits stdout, so its output and ReadyRun's land on one stream in
// the order they were written — and a Worker's last byte need not be a newline.
// Writing to the Run's own stdout is that descriptor, from the test's side.
const unterminated = "the Worker's last line, unterminated";

function capturing(): { chunks: string[]; stdout: { write(chunk: string): true } } {
  const chunks: string[] = [];
  return {
    chunks,
    stdout: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function tracker() {
  return memoryTracker({
    tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
}

function workerEndingMidLine(
  stdout: { write(chunk: string): true },
  exitCode: number,
) {
  return createWorkerAdapter({
    async spawn(request) {
      if (exitCode === 0) {
        await commitWorkerWork(request);
      }
      stdout.write(unterminated);
      return { exitCode };
    },
  });
}

test("a clean stop's report starts a line of its own with a blank line above, whatever the Worker left on the stream", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: tracker(),
        worker: workerEndingMidLine(out.stdout, 0),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.match(
      out.chunks.join(""),
      new RegExp(`${unterminated}\\n\\nRun complete: `),
    );
  } finally {
    await repo.cleanup();
  }
});

test("a hard stop's report starts a line of its own with a blank line above, whatever the Worker left on the stream", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: tracker(),
        worker: workerEndingMidLine(out.stdout, 42),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 1);
    assert.match(
      out.chunks.join(""),
      new RegExp(`${unterminated}\\n\\nHard stop: `),
    );
  } finally {
    await repo.cleanup();
  }
});

// ADR 0032: off a TTY the output carries no control characters, so the
// separation cannot be a cursor move or a rule — whitespace is the whole of it.
test("the separation off a TTY is whitespace: no carriage return and no escape anywhere in either report's Run", async () => {
  const repo = await throwawayRepo();
  const clean = capturing();
  const hard = capturing();
  try {
    assert.equal(
      await run({
        config: defineConfig({
          tracker: tracker(),
          worker: workerEndingMidLine(clean.stdout, 0),
          model: "composer-2",
        }),
        cap: 1,
        cwd: repo.cwd,
        stdout: clean.stdout,
      }),
      0,
    );
    assert.equal(
      await run({
        config: defineConfig({
          tracker: tracker(),
          worker: workerEndingMidLine(hard.stdout, 42),
          model: "composer-2",
        }),
        cap: 1,
        cwd: repo.cwd,
        stdout: hard.stdout,
      }),
      1,
    );

    for (const out of [clean, hard]) {
      assert.doesNotMatch(out.chunks.join(""), /[\r\x1b]/);
    }
  } finally {
    await repo.cleanup();
  }
});
