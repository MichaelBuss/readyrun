import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { defineConfig, doctor, github, run } from "../src/mod.ts";
import { recordingWorker } from "../src/testing/mod.ts";
import { githubFromWorld, githubHttpFixture } from "./github-http-fixture.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);
const silent = { write(_chunk?: string) { return true; } };

const world = {
  tickets: [ticket({ id: "52" })],
  ready: "unblocked" as const,
  labels: ["ready-for-agent"],
};

async function repoWithOrigin(url = "git@github.com:acme/widgets.git") {
  const repo = await throwawayRepo();
  await exec("git", ["-C", repo.cwd, "remote", "add", "origin", url]);
  return repo;
}

test("success drops the frontier label, comments, and does not close", async () => {
  const { adapter, fixture } = githubFromWorld(world);
  const frontier = await adapter.frontier();
  const finished = frontier[0];
  assert.ok(finished);
  await adapter.leaveFrontier(finished);

  assert.ok(
    fixture.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.endsWith("/issues/52/labels/ready-for-agent"),
    ),
  );
  const comments = fixture.requests.filter(
    (request) =>
      request.method === "POST" && request.url.endsWith("/issues/52/comments"),
  );
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /left the Frontier/);
  assert.equal(
    fixture.requests.filter((request) => request.method === "PATCH").length,
    0,
  );
  assert.ok(
    !fixture.requests.some((request) =>
      (request.body ?? "").includes("closeIssue") ||
      (request.body ?? "").includes("\"state\":\"closed\"")
    ),
  );
});

test("inspect reports labels that exist on GitHub, not the selector", async () => {
  const { adapter } = githubFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    existingLabels: ["ready-for-agent", "bug"],
  });
  const inspect = await adapter.inspect();
  assert.deepEqual(inspect.existingLabels, ["ready-for-agent", "bug"]);
  assert.deepEqual(inspect.selectorLabels, ["ready-for-agent"]);
  assert.equal(inspect.repository, "acme/widgets");
  assert.equal(inspect.canExpressBlocking, true);
});

test("Doctor fails when a named GitHub label does not exist on the repository", async () => {
  const repo = await repoWithOrigin();
  const { adapter } = githubFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["does-not-exist"],
    existingLabels: ["ready-for-agent"],
  });
  const chunks: string[] = [];
  try {
    const exit = await doctor({
      config: defineConfig({
        tracker: adapter,
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(exit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: label "does-not-exist" does not exist on the Tracker/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("Doctor fails when GitHub cannot express blocking", async () => {
  const repo = await repoWithOrigin();
  const { adapter } = githubFromWorld({
    ...world,
    canExpressBlocking: false,
  });
  const chunks: string[] = [];
  try {
    const exit = await doctor({
      config: defineConfig({
        tracker: adapter,
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(exit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: Tracker cannot express blocking; unblocked ordering is a lie/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("ReadyRun authenticates to GitHub via GH_TOKEN; the Worker is not given the token", async () => {
  const repo = await repoWithOrigin();
  const fixture = githubHttpFixture({ repo: "acme/widgets", ...world });
  const adapter = github(
    {
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    },
    {
      env: { GH_TOKEN: "test-token" },
      ghAuthToken: () => Promise.reject(new Error("gh should not be called")),
      fetch: fixture.fetch,
    },
  );
  const worker = recordingWorker({ exitCode: 0 });
  try {
    const exit = await run({
      config: defineConfig({
        tracker: adapter,
        worker,
        model: "composer-2",
      }),
      cap: 1,
      cwd: repo.cwd,
      stdout: silent,
    });
    assert.equal(exit, 0);
    assert.equal(worker.spawns.length, 1);
    assert.equal(JSON.stringify(worker.spawns[0]).includes("test-token"), false);
  } finally {
    await repo.cleanup();
  }
});

test("ReadyRun authenticates to GitHub via gh when no token is in the environment", async () => {
  const fixture = githubHttpFixture({ repo: "acme/widgets", ...world });
  const adapter = github(
    {
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    },
    {
      env: {},
      ghAuthToken: () => Promise.resolve("test-token"),
      fetch: fixture.fetch,
    },
  );
  const frontier = await adapter.frontier();
  assert.deepEqual(frontier.map((item) => item.id), ["52"]);
});

test("Doctor fails when ReadyRun cannot authenticate to GitHub", async () => {
  const repo = await repoWithOrigin();
  const adapter = github(
    {
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    },
    {
      env: {},
      ghAuthToken: () => Promise.resolve(undefined),
    },
  );
  const chunks: string[] = [];
  try {
    const exit = await doctor({
      config: defineConfig({
        tracker: adapter,
        worker: recordingWorker({ exitCode: 0 }),
        model: "composer-2",
      }),
      cwd: repo.cwd,
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
          return true;
        },
      },
    });
    assert.equal(exit, 1);
    assert.match(
      chunks.join(""),
      /Doctor: ReadyRun could not authenticate to GitHub/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("the Worker prompt names this Ticket as GitHub and the Ticket id", async () => {
  const { adapter } = githubFromWorld(world);
  const [picked] = await adapter.frontier();
  assert.ok(picked);
  assert.match(adapter.promptCopy(picked), /GitHub #52/);
  assert.match(adapter.promptCopy(picked), /https:\/\/example\.test\/52/);
});
