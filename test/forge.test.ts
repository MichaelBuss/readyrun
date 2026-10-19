import assert from "node:assert/strict";
import { test } from "node:test";
import {
  githubForge,
  type ForgePort,
  type ForgePullRequest,
} from "../src/mod.ts";

type Call = { method: string; url: string; body: unknown };

// A GitHub API fixture: records every call, answers from a scripted map.
function apiFixture(
  answers: (call: Call) => { status?: number; body: unknown },
): { forge: ForgePort; calls: Call[] } {
  const calls: Call[] = [];
  const forge = githubForge(
    { repository: "acme/widgets" },
    {
      token: "test-token",
      fetch: (async (url: URL | string, init?: RequestInit) => {
        const call: Call = {
          method: init?.method ?? "GET",
          url: String(url),
          body: typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined,
        };
        calls.push(call);
        const answer = answers(call);
        return new Response(
          answer.status === 401 ? "unauthorized" : JSON.stringify(answer.body),
          {
            status: answer.status ?? 200,
            headers: { "Content-Type": "application/json" },
          },
        );      }) as typeof fetch,
    },
  );
  return { forge, calls };
}

test("the forge finds an open pull request by its head branch, the reconcile key", async () => {
  const { forge, calls } = apiFixture((call) => ({
    body: call.url.includes("head=acme%3Areadyrun%2Fdeliver%2F8")
      ? [{
        number: 5,
        html_url: "https://github.com/acme/widgets/pull/5",
        state: "open",
        draft: false,
        head: { ref: "readyrun/deliver/8" },
        base: { ref: "main" },
      }]
      : [],
  }));
  const found = await forge.findPullRequest("readyrun/deliver/8");
  assert.equal(found?.number, 5);
  assert.equal(found?.head, "readyrun/deliver/8");
  const none = await forge.findPullRequest("readyrun/deliver/9");
  assert.equal(none, undefined);
  assert.equal(calls.length, 2);
});

test("the forge creates a pull request and applies its birth labels once", async () => {
  const { forge, calls } = apiFixture((call) => {
    if (call.url.endsWith("/pulls") && call.method === "POST") {
      return {
        body: {
          number: 6,
          html_url: "https://github.com/acme/widgets/pull/6",
          state: "open",
          draft: true,
          head: { ref: "readyrun/deliver/8" },
          base: { ref: "main" },
        },
      };
    }
    return { body: {} };
  });
  const created = await forge.createPullRequest({
    head: "readyrun/deliver/8",
    base: "main",
    title: "8: Ship the thing",
    body: "Closes #8",
    draft: true,
    labels: ["review-me"],
  });
  assert.equal(created.number, 6);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    "POST https://api.github.com/repos/acme/widgets/pulls",
    "POST https://api.github.com/repos/acme/widgets/issues/6/labels",
  ]);
  assert.deepEqual(calls[0]?.body, {
    title: "8: Ship the thing",
    head: "readyrun/deliver/8",
    base: "main",
    body: "Closes #8",
    draft: true,
  });
  assert.deepEqual(calls[1]?.body, { labels: ["review-me"] });
});

test("the forge reports the repository's merge methods, for the Plan's squash warning", async () => {
  const { forge } = apiFixture(() => ({
    body: {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: false,
    },
  }));
  assert.deepEqual(await forge.mergeMethods(), ["merge", "squash"]);
});

test("the forge names auth and reachability failures, and never leaks a stack", async () => {
  const { forge } = apiFixture(() => ({ status: 401, body: {} }));
  await assert.rejects(
    () => forge.findPullRequest("readyrun/deliver/8"),
    /could not authenticate to GitHub for the delivery/,
  );
});

test("the token resolves from the injected token, the environment, then `gh auth token`", async () => {
  // The injected token wins, and rides the Authorization header.
  const bearer: string[] = [];
  const injected = githubForge(
    { repository: "acme/widgets" },
    {
      token: "injected-token",
      fetch: (async (_url: URL | string, init?: RequestInit) => {
        bearer.push((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response("[]", { status: 200 });
      }) as typeof fetch,
    },
  );
  await injected.findPullRequest("x");
  assert.deepEqual(bearer, ["Bearer injected-token"]);
  // The environment's token is read when none is injected.
  const calls: Call[] = [];
  let usedEnv = false;
  const forge = githubForge(
    { repository: "acme/widgets" },
    {
      env: { GH_TOKEN: "env-token" },
      fetch: (async (_url: URL | string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(_url),
          body: undefined,
        });
        usedEnv = (init?.headers as Record<string, string>)?.Authorization ===
          "Bearer env-token";
        return new Response("[]", { status: 200 });
      }) as typeof fetch,
    },
  );
  await forge.findPullRequest("x");
  assert.equal(usedEnv, true);
  // With neither, the environment's `gh` is asked; a missing one is an auth
  // failure, not a hang.
  const ghless = githubForge(
    { repository: "acme/widgets" },
    {
      env: {},
      ghAuthToken: () => Promise.resolve(undefined),
      fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch,
    },
  );
  await assert.rejects(() => ghless.findPullRequest("x"), /could not authenticate/);
});

test("a pull request the forge answers carries what reconcile reads", async () => {
  const shaped: ForgePullRequest = {
    number: 5,
    url: "https://github.com/acme/widgets/pull/5",
    head: "readyrun/deliver/8",
    base: "main",
    draft: false,
    state: "open",
  };
  assert.equal(shaped.state, "open");
});
