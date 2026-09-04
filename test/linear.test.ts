import assert from "node:assert/strict";
import { test } from "node:test";
import { defineConfig, doctor, linear, run, UnknownConfigKeyError } from "../src/mod.ts";
import { recordingWorker } from "../src/testing/mod.ts";
import {
  linearDoneStateId,
  linearFromWorld,
  linearHttpFixture,
  linearInReviewStateId,
} from "./linear-http-fixture.ts";
import { landing, ticket } from "./tracker-adapter-contract.ts";
import { throwawayRepo } from "./throwaway-repo.ts";

const silent = { write(_chunk?: string) { return true; } };

const world = {
  tickets: [ticket({ id: "52" })],
  ready: "unblocked" as const,
  labels: ["ready-for-agent"],
};

test("success moves the Ticket to In Review and never Done", async () => {
  const { adapter, fixture } = linearFromWorld(world);
  const frontier = await adapter.frontier();
  const finished = frontier[0];
  assert.ok(finished);
  await adapter.leaveFrontier(finished, landing());

  const bodies = fixture.requests.map((request) => request.body ?? "").join("\n");
  assert.match(bodies, new RegExp(linearInReviewStateId));
  assert.equal(bodies.includes(linearDoneStateId), false);
  assert.equal(
    fixture.requests.some((request) =>
      (request.body ?? "").includes("\"type\":\"completed\"")
    ),
    false,
  );
});

test("when Linear exposes a suggested branch name, that is the Branch", async () => {
  const { adapter } = linearFromWorld({
    ...world,
    suggestedBranchNames: { "52": "feature/eng-52-ticket-52" },
  });
  const [picked] = await adapter.frontier();
  assert.ok(picked);
  assert.equal(adapter.branchName(picked), "feature/eng-52-ticket-52");
});

test("when Linear has no suggested branch name, the Branch is a convention over the identifier", async () => {
  const { adapter } = linearFromWorld(world);
  const [picked] = await adapter.frontier();
  assert.ok(picked);
  assert.equal(adapter.branchName(picked), "readyrun/52");
});

test("an unblocked Ticket that does not match the Linear state is not on the Frontier", async () => {
  const { adapter } = linearFromWorld({
    tickets: [ticket({ id: "52" }), ticket({ id: "99" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    state: "Todo",
    ticketStates: { "52": "Todo", "99": "In Progress" },
    existingStates: ["Todo", "In Progress", "In Review", "Done"],
  });
  const frontier = await adapter.frontier();
  assert.deepEqual(
    frontier.map((item) => item.id),
    ["52"],
  );
});

test("a Ticket blocked by work that does not match the selector is still blocked", async () => {
  const { adapter } = linearFromWorld({
    tickets: [
      ticket({ id: "52", labels: ["other"] }),
      ticket({
        id: "53",
        labels: ["ready-for-agent"],
        blockedBy: ["52"],
      }),
    ],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  });
  const frontier = await adapter.frontier();
  assert.deepEqual(
    frontier.map((item) => item.id),
    [],
  );
});

test("an unblocked Ticket that does not match the Linear project is not on the Frontier", async () => {
  const { adapter } = linearFromWorld({
    tickets: [ticket({ id: "52" }), ticket({ id: "99" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    project: "Alpha",
    ticketProjects: { "52": "Alpha", "99": "Beta" },
    existingProjects: ["Alpha", "Beta"],
  });
  const frontier = await adapter.frontier();
  assert.deepEqual(
    frontier.map((item) => item.id),
    ["52"],
  );
});

test("Linear Frontier needs a state, label, or project", () => {
  assert.throws(
    () => linear({ ready: "unblocked" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /state, label, or project/);
      return true;
    },
  );
});

test("unknown keys on the Linear Tracker Adapter factory are an error", () => {
  const options = {
    ready: "unblocked" as const,
    label: "ready-for-agent",
    team: "ENG",
  };
  assert.throws(
    () => linear(options),
    (error: unknown) => {
      assert.ok(error instanceof UnknownConfigKeyError);
      assert.deepEqual([...error.keys], ["team"]);
      return true;
    },
  );
});

test("inspect reports labels, states, and projects that exist on Linear, not only the selector", async () => {
  const { adapter } = linearFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    state: "Todo",
    project: "Alpha",
    existingLabels: ["ready-for-agent", "bug"],
    existingStates: ["Todo", "In Review", "Done"],
    existingProjects: ["Alpha", "Beta"],
  });
  const inspect = await adapter.inspect();
  assert.deepEqual(inspect.existingLabels, ["ready-for-agent", "bug"]);
  assert.deepEqual(inspect.selectorLabels, ["ready-for-agent"]);
  assert.deepEqual(inspect.existingStates, ["Todo", "In Review", "Done"]);
  assert.equal(inspect.selectorState, "Todo");
  assert.deepEqual(inspect.existingProjects, ["Alpha", "Beta"]);
  assert.equal(inspect.selectorProject, "Alpha");
  assert.equal(inspect.canExpressBlocking, true);
});

test("Doctor fails when a named Linear label does not exist on the Tracker", async () => {
  const repo = await throwawayRepo();
  const { adapter } = linearFromWorld({
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

test("Doctor fails when a named Linear state does not exist on the Tracker", async () => {
  const repo = await throwawayRepo();
  const { adapter } = linearFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    state: "does-not-exist",
    existingStates: ["Todo", "In Review"],
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
      /Doctor: state "does-not-exist" does not exist on the Tracker/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("Doctor fails when a named Linear project does not exist on the Tracker", async () => {
  const repo = await throwawayRepo();
  const { adapter } = linearFromWorld({
    tickets: [ticket({ id: "52" })],
    ready: "unblocked",
    labels: ["ready-for-agent"],
    project: "does-not-exist",
    existingProjects: ["Alpha"],
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
      /Doctor: project "does-not-exist" does not exist on the Tracker/,
    );
  } finally {
    await repo.cleanup();
  }
});

test("Doctor fails when Linear cannot express blocking", async () => {
  const repo = await throwawayRepo();
  const { adapter } = linearFromWorld({
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

test("ReadyRun authenticates to Linear via LINEAR_API_KEY; the Worker is not given the token", async () => {
  const repo = await throwawayRepo();
  const fixture = linearHttpFixture(world);
  const adapter = linear(
    {
      ready: "unblocked",
      label: "ready-for-agent",
    },
    {
      env: { LINEAR_API_KEY: "test-token" },
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

test("Doctor fails when ReadyRun cannot authenticate to Linear", async () => {
  const repo = await throwawayRepo();
  const adapter = linear(
    {
      ready: "unblocked",
      label: "ready-for-agent",
    },
    {
      env: {},
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
      /Doctor: ReadyRun could not authenticate to Linear/,
    );
    assert.match(chunks.join(""), /Check the Linear token/);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor does not print a raw Linear GraphQL HTTP string as the failure", async () => {
  const repo = await throwawayRepo();
  const adapter = linear(
    {
      ready: "unblocked",
      label: "ready-for-agent",
    },
    {
      token: "test-token",
      fetch: async () =>
        new Response(JSON.stringify({}), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
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
    const output = chunks.join("");
    assert.match(output, /Doctor: ReadyRun could not reach Linear/);
    assert.match(output, /Check Tracker auth and network/);
    assert.match(output, /Linear GraphQL HTTP 500/);
    assert.doesNotMatch(output, /^Doctor: Linear GraphQL HTTP 500$/m);
  } finally {
    await repo.cleanup();
  }
});

test("Doctor does not print a raw Linear fetch throw as the failure", async () => {
  const repo = await throwawayRepo();
  const adapter = linear(
    {
      ready: "unblocked",
      label: "ready-for-agent",
    },
    {
      token: "test-token",
      fetch: async () => {
        throw new Error("fetch failed");
      },
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
    const output = chunks.join("");
    assert.match(output, /Doctor: ReadyRun could not reach Linear/);
    assert.match(output, /Check Tracker auth and network/);
    assert.match(output, /fetch failed/);
    assert.doesNotMatch(output, /^Doctor: fetch failed$/m);
  } finally {
    await repo.cleanup();
  }
});

test("the Worker prompt names this Ticket as Linear and the Ticket id", async () => {
  const { adapter } = linearFromWorld(world);
  const [picked] = await adapter.frontier();
  assert.ok(picked);
  assert.match(adapter.promptCopy(picked), /Linear 52/);
  assert.doesNotMatch(adapter.promptCopy(picked), /GitHub|#52/);
  assert.match(adapter.promptCopy(picked), /https:\/\/example\.test\/52/);
});
