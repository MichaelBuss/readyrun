import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, run } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { git, runBranch, runBranches, throwawayRepo } from "./throwaway-repo.ts";

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

function lines(chunks: string[]): string[] {
  return chunks.join("").split("\n").filter(Boolean);
}

function lastTwo(chunks: string[]): string[] {
  return lines(chunks).slice(-2);
}

test("a Run that empties the Frontier reports the Tickets it landed, the Run Branch it collected them onto, the base it was cut from, and the empty Frontier", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", title: "Fix the thing" }),
            ticket({ id: "57", title: "Fix the other thing" }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 5,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lastTwo(out.chunks), [
      "Run complete: the Frontier is empty",
      `2 Tickets landed on ${await runBranch(repo.cwd)}, cut from ${
        base.slice(0, 7)
      }.`,
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("a Run that stops on the cap names the cap as the reason, so it is clear that work may remain", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const base = await git(repo.cwd, ["rev-parse", "HEAD"]);

    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [
            ticket({ id: "52", title: "Fix the thing" }),
            ticket({ id: "57", title: "Fix the other thing" }),
          ],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(lastTwo(out.chunks), [
      "Run complete: cap of 1 Ticket reached; the Frontier may still hold work",
      `1 Ticket landed on ${await runBranch(repo.cwd)}, cut from ${
        base.slice(0, 7)
      }.`,
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("a Run that lands nothing says no Run Branch was created, and names no ref that does not exist", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "99", labels: ["other"] })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 3,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(await runBranches(repo.cwd), []);
    assert.deepEqual(lastTwo(out.chunks), [
      "Run complete: the Frontier is empty",
      "0 Tickets landed; no Run Branch was created.",
    ]);
    // The disclosure at the top names the Run Branch it may create; the report
    // must not repeat a name git has no ref for.
    assert.equal(
      lines(out.chunks).filter((line) => line.includes("readyrun/run-")).length,
      1,
    );
  } finally {
    await repo.cleanup();
  }
});

test("a completion report prescribes no integration: no push, no merge, no pull request", async () => {
  const repo = await throwawayRepo();
  const capped = capturing();
  const emptied = capturing();
  try {
    const config = () =>
      defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" }), ticket({ id: "57" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      });

    assert.equal(
      await run({ config: config(), cap: 1, cwd: repo.cwd, stdout: capped.stdout }),
      0,
    );
    assert.equal(
      await run({ config: config(), cap: 5, cwd: repo.cwd, stdout: emptied.stdout }),
      0,
    );

    for (const out of [capped, emptied]) {
      assert.doesNotMatch(
        lastTwo(out.chunks).join("\n"),
        /push|merg|pull request|\bPR\b/i,
      );
    }
  } finally {
    await repo.cleanup();
  }
});

test("off a TTY the completion report is plain lines, with no spinner control characters", async () => {
  const repo = await throwawayRepo();
  const out = capturing();
  try {
    const exitCode = await run({
      config: defineConfig({
        tracker: memoryTracker({
          tickets: [ticket({ id: "52" })],
          ready: "unblocked",
          labels: ["ready-for-agent"],
        }),
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: out.stdout,
    });

    assert.equal(exitCode, 0);
    const text = out.chunks.join("");
    assert.doesNotMatch(text, /[\r\x1b]/);
    assert.match(text, /^Run complete: cap of 1 Ticket reached[^\n]*\n/m);
    assert.match(text, /^1 Ticket landed on readyrun\/run-[^\n]*\n/m);
  } finally {
    await repo.cleanup();
  }
});
