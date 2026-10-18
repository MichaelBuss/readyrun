import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  computeDeliveryPlan,
  createDelivery,
  deliverPlan,
  type DeliveryPlan,
  resolveDeliveryMode,
  type DeliverInput,
  type ForgeCreateInput,
  type ForgePort,
  type ForgePullRequest,
} from "../src/mod.ts";
import { defineConfig } from "../src/config.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";
import type { Ticket } from "../src/ticket.ts";
import { ticket } from "./tracker-adapter-contract.ts";
import { git, throwawayClone, throwawayRepo } from "./throwaway-repo.ts";

const exec = promisify(execFile);

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

// Land one Ticket the way a Run's collect does (ADR 0028): exactly one merge
// commit on the Run Branch's first-parent history, its message derived from
// the Ticket. Plumbing only, so the Consumer's checkout never moves.
async function landTicket(
  cwd: string,
  runBranch: string,
  ticket: { id: string; title: string },
): Promise<string> {
  const existing = await git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${runBranch}`,
  ]).catch(() => "");
  const base = existing === "" ? await git(cwd, ["rev-parse", "HEAD"]) : existing;
  const tree = await git(cwd, ["rev-parse", `${base}^{tree}`]);
  const work = await exec("git", ["-C", cwd, "commit-tree", tree, "-m", `Ticket ${ticket.id} work`]);
  const merge = await exec("git", [
    "-C",
    cwd,
    "commit-tree",
    tree,
    "-p",
    base,
    "-p",
    work.stdout.trim(),
    "-m",
    `Ticket ${ticket.id}: ${ticket.title}`,
  ]);
  const mergeCommit = merge.stdout.trim();
  await exec("git", [
    "-C",
    cwd,
    "update-ref",
    `refs/heads/${runBranch}`,
    mergeCommit,
    existing,
  ]);
  return mergeCommit;
}

async function createRunBranch(
  cwd: string,
  landed: { id: string; title: string }[],
  runBranch = "readyrun/run-20261018-120000",
): Promise<{ runBranch: string; tip: string }> {
  for (const one of landed) {
    await landTicket(cwd, runBranch, one);
  }
  return {
    runBranch,
    tip: await git(cwd, ["rev-parse", `refs/heads/${runBranch}`]),
  };
}

// The forge the tests script: a recording create, a seeded open-PR answer,
// and the merge methods the repository admits.
function fakeForge(options: {
  openPullRequests?: ForgePullRequest[];
  mergeMethods?: string[];
  created?: ForgeCreateInput[];
}): ForgePort {
  return {
    repository: "acme/widgets",
    async findPullRequest(head) {
      return options.openPullRequests?.find((pull) => pull.head === head);
    },
    async createPullRequest(input) {
      options.created?.push(input);
      const number = (options.created?.length ?? 1) + 100;
      return {
        number,
        url: `https://github.com/acme/widgets/pull/${number}`,
        head: input.head,
        base: input.base,
        draft: input.draft,
        state: "open",
      };
    },
    async mergeMethods() {
      return options.mergeMethods ?? ["merge"];
    },
  };
}

function deliveryConfig(tickets: Ticket[], forge?: ForgePort) {
  return defineConfig({
    tracker: memoryTracker({
      tickets,
      ready: "unblocked",
      labels: ["ready-for-agent"],
      forge: forge === undefined ? undefined : "github",
    }),
    worker: recordingWorker({ exitCode: 0 }),
    model: "composer-2",
  });
}

function deliverOptions(
  cwd: string,
  branch: string,
  config: ReturnType<typeof deliveryConfig>,
  overrides: Partial<DeliverInput> = {},
): DeliverInput {
  return {
    config,
    mode: "family-pr",
    branch,
    cwd,
    stdout: capturing().stdout,
    forge: fakeForge({}),
    ...overrides,
  };
}

// A landed family: parent 8 with children 52 and 57, whose selector labels
// have dropped the way a finished Ticket's do on GitHub.
const familyLanded: Ticket[] = [
  ticket({ id: "8", title: "Ship the thing" }),
  ticket({ id: "52", title: "Left side", parent: "8", labels: [] }),
  ticket({ id: "57", title: "Right side", parent: "8", labels: [] }),
];

test("family-pr publishes a completed family as one pull request titled after the parent, keyed by a head branch derived from Tracker identity", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch, tip } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const created: ForgeCreateInput[] = [];
    const forge = fakeForge({ created });
    const out = capturing();
    const input = deliverOptions(repo.cwd, runBranch, config, {
      forge,
      stdout: out.stdout,
    });
    const plan = await computeDeliveryPlan(input);
    assert.deepEqual(plan.doctorFailures, []);
    assert.equal(plan.publications.length, 1);
    const publication = plan.publications[0]!;
    assert.equal(publication.desired.head, "readyrun/deliver/8");
    assert.equal(publication.desired.commit, tip);
    assert.equal(publication.desired.base, "main");
    assert.equal(publication.refState, "missing");
    assert.equal(publication.desired.title, "8: Ship the thing");
    assert.match(publication.desired.body, /Closes #8/);
    assert.match(publication.desired.body, /Closes #52/);
    assert.match(publication.desired.body, /Closes #57/);
    assert.match(publication.desired.body, new RegExp(runBranch));

    const exit = await deliverPlan(plan, {
      config,
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(exit, 0);
    // The ref is on the remote, at the family's tip, under its own name.
    const remoteTip = await git(upstream.cwd, [
      "rev-parse",
      "refs/heads/readyrun/deliver/8",
    ]);
    assert.equal(remoteTip, tip);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.base, "main");
    // The report says what was published.
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    assert.match(lines.join("\n"), /^Pushed readyrun\/deliver\/8 at /m);
    assert.match(lines.join("\n"), /^Opened PR #\d+: /m);
    assert.match(lines.join("\n"), /Delivery complete: 1 pull request opened, 1 ref pushed\./m);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("a retried delivery re-prices and finds its own half-done work by name, opening nothing twice", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const created: ForgeCreateInput[] = [];
    const forge = fakeForge({ created });
    const first = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { forge }),
    );
    assert.equal(
      await deliverPlan(first, {
        config,
        cwd: repo.cwd,
        stdout: capturing().stdout,
      }),
      0,
    );
    // The retry: the ref is now on the remote at the same commit, and the
    // forge answers an open PR for that head branch.
    const second = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, {
        forge: fakeForge({
          created,
          openPullRequests: [
            {
              number: 5,
              url: "https://github.com/acme/widgets/pull/5",
              head: "readyrun/deliver/8",
              base: "main",
              draft: false,
              state: "open",
            },
          ],
        }),
      }),
    );
    const publication = second.publications[0]!;
    assert.equal(publication.refState, "present");
    assert.equal(publication.pullRequest?.number, 5);
    assert.equal(
      await deliverPlan(second, {
        config,
        cwd: repo.cwd,
        stdout: capturing().stdout,
      }),
      0,
    );
    // The PR was created once, by the first delivery.
    assert.equal(created.length, 1);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("a remote ref that moved is refused, never rewritten", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch, tip } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    // Something else lives at the delivery's head name.
    await exec("git", [
      "-C",
      upstream.cwd,
      "update-ref",
      "refs/heads/readyrun/deliver/8",
      await git(upstream.cwd, ["rev-parse", "HEAD"]),
    ]);
    const config = deliveryConfig(familyLanded);
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config),
    );
    assert.equal(plan.publications[0]?.refState, "moved");
    assert.equal(
      plan.publications[0]?.remoteTip,
      await git(upstream.cwd, ["rev-parse", "refs/heads/readyrun/deliver/8"]),
    );
    const out = capturing();
    const exit = await deliverPlan(plan, {
      config,
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(exit, 1);
    assert.match(out.chunks.join(""), /rewriting is never delivery's/);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("family-pr refuses a family whose merges are interleaved with an unrelated Ticket", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "70", title: "Unrelated" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig([
      ticket({ id: "8", title: "Ship the thing" }),
      ticket({ id: "52", title: "Left side", parent: "8", labels: [] }),
      ticket({ id: "57", title: "Right side", parent: "8", labels: [] }),
      ticket({ id: "70", title: "Unrelated", labels: [] }),
    ]);
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config),
    );
    assert.equal(plan.publications.length, 0);
    assert.equal(plan.doctorFailures.length, 1);
    assert.match(plan.doctorFailures[0]!, /interleaved with the family 8 range/);
    assert.match(plan.doctorFailures[0]!, /diff would not be exactly the family's work/);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("family-pr refuses when the commit below the family's first merge is not in the default branch", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "70", title: "Unrelated" },
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig([
      ticket({ id: "8", title: "Ship the thing" }),
      ticket({ id: "52", title: "Left side", parent: "8", labels: [] }),
      ticket({ id: "57", title: "Right side", parent: "8", labels: [] }),
      ticket({ id: "70", title: "Unrelated", labels: [] }),
    ]);
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config),
    );
    assert.equal(plan.doctorFailures.length, 1);
    assert.match(
      plan.doctorFailures[0]!,
      /below the family 8's first merge.*is not in the default branch \(main\)/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("family-pr publishes an incomplete family's note and nothing else", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
    ]);
    // 57 still wears the selector label: the family is still landing.
    const config = deliveryConfig([
      ticket({ id: "8", title: "Ship the thing" }),
      ticket({ id: "52", title: "Left side", parent: "8", labels: [] }),
      ticket({ id: "57", title: "Right side", parent: "8" }),
    ]);
    const out = capturing();
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { stdout: out.stdout }),
    );
    assert.deepEqual(plan.doctorFailures, []);
    assert.equal(plan.publications.length, 0);
    assert.equal(plan.notes.length, 1);
    assert.match(plan.notes[0]!, /family 8 \(Ship the thing\) is still landing/);
    const exit = await deliverPlan(plan, {
      config,
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(exit, 0);
    assert.match(out.chunks.join(""), /Delivery complete: nothing to publish\./);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("family-pr refuses on a forgeless Tracker, naming the cause", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
    ]);
    const config = defineConfig({
      tracker: memoryTracker({
        tickets: familyLanded,
        ready: "unblocked",
        labels: ["ready-for-agent"],
      }),
      worker: recordingWorker({ exitCode: 0 }),
      model: "composer-2",
    });
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { forge: undefined }),
    );
    assert.equal(plan.doctorFailures.length, 1);
    assert.match(
      plan.doctorFailures[0]!,
      /mode family-pr publishes pull requests, and the Tracker Adapter declares no forge deliver can drive/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("stack publishes one ref and one PR per merge commit, each based on the previous, and warns on squash", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const created: ForgeCreateInput[] = [];
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, {
        mode: "stack",
        forge: fakeForge({ created, mergeMethods: ["merge", "squash"] }),
      }),
    );
    assert.deepEqual(plan.doctorFailures, []);
    assert.deepEqual(
      plan.publications.map((publication) => publication.desired.head),
      ["readyrun/deliver/52", "readyrun/deliver/57"],
    );
    assert.equal(plan.publications[0]?.desired.base, "main");
    assert.equal(
      plan.publications[1]?.desired.base,
      "readyrun/deliver/52",
    );
    assert.equal(plan.squashWarning, true);
    assert.equal(
      await deliverPlan(plan, {
        config,
        cwd: repo.cwd,
        stdout: capturing().stdout,
      }),
      0,
    );
    assert.equal(
      await git(upstream.cwd, ["rev-parse", "refs/heads/readyrun/deliver/52"]),
      plan.publications[0]?.desired.commit,
    );
    assert.equal(created.length, 2);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("main fast-forwards the default branch to the Run Branch and refuses when the checkout sits on it", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch, tip } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
    ]);
    const config = deliveryConfig(familyLanded);
    // Off the default branch, the delivery can fetch it forward.
    await exec("git", ["-C", repo.cwd, "checkout", "-b", "side"]);
    const out = capturing();
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, {
        mode: "main",
        stdout: out.stdout,
      }),
    );
    assert.deepEqual(plan.doctorFailures, []);
    assert.equal(plan.fastForwards.length, 1);
    assert.equal(plan.fastForwards[0]?.state, "would-move");
    assert.equal(
      await deliverPlan(plan, {
        config,
        cwd: repo.cwd,
        stdout: out.stdout,
      }),
      0,
    );
    assert.equal(await git(repo.cwd, ["rev-parse", "refs/heads/main"]), tip);
    assert.match(
      out.chunks.join(""),
      /Fast-forwarded main to /,
    );
    // On the default branch, the delivery refuses before any side effect.
    await exec("git", ["-C", repo.cwd, "checkout", "main"]);
    const refused = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { mode: "main" }),
    );
    assert.equal(refused.doctorFailures.length, 1);
    assert.match(
      refused.doctorFailures[0]!,
      /the primary checkout sits on main/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("main discloses rather than refuses on unintegrated history, and refuses a diverged default branch", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    await exec("git", ["-C", repo.cwd, "checkout", "-b", "side"]);
    // An unrelated merge on top of the Run Branch rides the fast-forward,
    // disclosed in the Plan — `main` never refuses unintegrated history.
    await landTicket(repo.cwd, runBranch, { id: "70", title: "Unrelated" });
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { mode: "main" }),
    );
    assert.deepEqual(plan.doctorFailures, []);
    assert.equal(plan.fastForwards[0]?.state, "would-move");
    // A default branch that has diverged is not a fast-forward: refused.
    // An orphan commit is the smallest divergence git can name.
    const tree = await git(repo.cwd, ["rev-parse", "HEAD^{tree}"]);
    const orphan = await exec("git", [
      "-C",
      repo.cwd,
      "commit-tree",
      tree,
      "-m",
      "diverged",
    ]);
    await exec("git", [
      "-C",
      repo.cwd,
      "update-ref",
      "refs/heads/main",
      orphan.stdout.trim(),
    ]);
    const diverged = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { mode: "main" }),
    );
    assert.equal(diverged.fastForwards[0]?.state, "refuses");
    assert.match(
      diverged.fastForwards[0]?.problem ?? "",
      /would not be a fast-forward/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("an empty range delivers nothing and says so", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    // The Run Branch exists but the default branch already contains it.
    await exec("git", [
      "-C",
      repo.cwd,
      "update-ref",
      "refs/heads/readyrun/run-20261018-120000",
      await git(repo.cwd, ["rev-parse", "HEAD"]),
    ]);
    const config = deliveryConfig(familyLanded);
    const out = capturing();
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, "readyrun/run-20261018-120000", config, {
        stdout: out.stdout,
      }),
    );
    assert.equal(plan.empty, true);
    const exit = await deliverPlan(plan, {
      config,
      cwd: repo.cwd,
      stdout: out.stdout,
    });
    assert.equal(exit, 0);
    assert.match(
      out.chunks.join(""),
      /holds no history the default branch lacks; nothing to deliver/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("Doctor refuses an unknown mode, a missing Run Branch, and creation options on a mode that publishes none", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const unknown = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, { mode: "ship-it" }),
    );
    assert.match(
      unknown.doctorFailures.join("\n"),
      /mode "ship-it" is not a built-in \(family-pr, stack, main\) and names no registered Delivery strategy/,
    );
    const missing = await computeDeliveryPlan(
      deliverOptions(repo.cwd, "readyrun/run-does-not-exist", config),
    );
    assert.match(
      missing.doctorFailures.join("\n"),
      /Run Branch readyrun\/run-does-not-exist does not exist in this checkout/,
    );
    const creationOptions = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, {
        mode: "main",
        draft: true,
      }),
    );
    assert.match(
      creationOptions.doctorFailures.join("\n"),
      /--draft and --label are pull-request creation options, and mode main publishes none/,
    );
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("a registered Delivery strategy resolves by name and may not shadow a built-in", async () => {
  const registered = createDelivery({
    name: "ship",
    async describe() {
      return { publications: [] };
    },
  });
  assert.equal(resolveDeliveryMode("ship", [registered])?.name, "ship");
  assert.equal(resolveDeliveryMode("family-pr", [registered])?.name, "family-pr");
  assert.equal(resolveDeliveryMode("nowhere", [registered]), undefined);
  assert.throws(
    () =>
      resolveDeliveryMode("stack", [
        createDelivery({
          name: "stack",
          async describe() {
            return { publications: [] };
          },
        }),
      ]),
    /shadows the built-in mode "stack"/,
  );
  assert.throws(
    // Unknown keys refuse, the way the Tracker Adapter seam does.
    () =>
      createDelivery({
        name: "x",
        performs: async () => {},
        // deno-lint-ignore no-explicit-any
      } as any),
    /Unknown/,
  );
});

test("the preview renders the whole Plan read-only and prices the exit code", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch, tip } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const out = capturing();
    const { previewDelivery } = await import("../src/mod.ts");
    const exit = await previewDelivery(
      deliverOptions(repo.cwd, runBranch, config, { stdout: out.stdout }),
    );
    assert.equal(exit, 0);
    const text = out.chunks.join("");
    assert.match(text, /Delivery preview: nothing is published; this Plan is read-only/);
    assert.match(text, /Doctor: pass/);
    assert.match(text, /Mode: family-pr over /);
    assert.match(text, /Publication: readyrun\/deliver\/8 at /);
    assert.match(text, /Would push the ref, then open the pull request/);
    assert.match(text, /Deliver with: readyrun deliver --mode family-pr --branch /);
    // The preview pushed nothing.
    assert.equal(
      await git(upstream.cwd, ["for-each-ref", "refs/heads/readyrun/deliver/*"])
        .catch(() => ""),
      "",
    );
    void tip;
    // A refused delivery still renders its whole Plan, and says 1.
    const refusedOut = capturing();
    const refusedExit = await previewDelivery(
      deliverOptions(repo.cwd, "readyrun/run-missing", config, {
        stdout: refusedOut.stdout,
      }),
    );
    assert.equal(refusedExit, 1);
    assert.match(refusedOut.chunks.join(""), /Doctor: Run Branch readyrun\/run-missing does not exist/);
    void runBranch;
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

test("birth options ride the Plan: draft and labels reach exactly the created pull requests", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const created: ForgeCreateInput[] = [];
    const plan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config, {
        draft: true,
        labels: ["review-me"],
        forge: fakeForge({ created }),
      }),
    );
    assert.equal(
      await deliverPlan(plan, {
        config,
        cwd: repo.cwd,
        stdout: capturing().stdout,
      }),
      0,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]?.draft, true);
    assert.deepEqual(created[0]?.labels, ["review-me"]);
    assert.match(plan.command, /--draft --label review-me/);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});

// The Plan is computed once and consumed; nothing in it mutates while the
// reconcile reads it.
test("the plan is a plain read-only answer the reconcile consumes", async () => {
  const upstream = await throwawayRepo();
  const repo = await throwawayClone(upstream.cwd);
  try {
    const { runBranch } = await createRunBranch(repo.cwd, [
      { id: "52", title: "Left side" },
      { id: "57", title: "Right side" },
    ]);
    const config = deliveryConfig(familyLanded);
    const plan: DeliveryPlan = await computeDeliveryPlan(
      deliverOptions(repo.cwd, runBranch, config),
    );
    assert.deepEqual(plan.doctorFailures, []);
    assert.equal(plan.mode, "family-pr");
    assert.equal(plan.branch, runBranch);
    assert.equal(plan.notes.length, 0);
    assert.equal(plan.squashWarning, false);
  } finally {
    await upstream.cleanup();
    await repo.cleanup();
  }
});
