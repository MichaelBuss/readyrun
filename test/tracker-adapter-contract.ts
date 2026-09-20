import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTrackerOptions } from "../src/testing/memory-tracker.ts";
import type { Ticket } from "../src/ticket.ts";
import type { Landing, TrackerAdapter } from "../src/tracker-adapter.ts";

export type TrackerContractFactory = (
  world: MemoryTrackerOptions,
) => TrackerAdapter | Promise<TrackerAdapter>;

export function ticket(
  overrides: Partial<Ticket> & Pick<Ticket, "id">,
): Ticket {
  return {
    title: `Ticket ${overrides.id}`,
    body: "body",
    url: `https://example.test/${overrides.id}`,
    labels: ["ready-for-agent"],
    blockedBy: [],
    ...overrides,
  };
}

// A landing as `run` reports one: the Run Branch the Ticket was collected onto
// and the full merge commit git wrote.
export function landing(overrides: Partial<Landing> = {}): Landing {
  return {
    runBranch: "readyrun/run-20260904-143000",
    mergeCommit: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    ...overrides,
  };
}

export function trackerAdapterContract(
  name: string,
  create: TrackerContractFactory,
): void {
  test(`${name}: an unblocked Ticket that does not match the selector is not on the Frontier`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
        ticket({ id: "99", labels: ["other"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier();
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["52"],
    );
  });

  test(`${name}: a blocked Ticket is never on the Frontier, even if it matches the selector`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
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
      frontier.map((ticket) => ticket.id),
      ["52"],
    );
  });

  test(`${name}: a blocked selector Ticket answers as waiting, with its blockers`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
        ticket({
          id: "53",
          labels: ["ready-for-agent"],
          blockedBy: ["52"],
        }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const waiting = await adapter.waiting();
    assert.deepEqual(
      waiting.map((ticket) => ticket.id),
      ["53"],
    );
    assert.deepEqual(waiting[0]?.blockedBy, ["52"]);
  });

  test(`${name}: the waiting set and the Frontier partition the selector's candidates`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
        ticket({
          id: "53",
          labels: ["ready-for-agent"],
          blockedBy: ["52"],
        }),
        ticket({ id: "99", labels: ["other"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier();
    const waiting = await adapter.waiting();
    const frontierIds = frontier.map((ticket) => ticket.id);
    const waitingIds = waiting.map((ticket) => ticket.id);
    assert.deepEqual(
      [...frontierIds, ...waitingIds].sort(),
      ["52", "53"],
    );
    for (const id of waitingIds) {
      assert.ok(!frontierIds.includes(id));
    }
  });

  test(`${name}: an optional parent root narrows the Frontier to that parent's children`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "8" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      parent: "8",
    });

    const frontier = await adapter.frontier();
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["11"],
    );
  });

  test(`${name}: an optional ids root narrows the Frontier to that explicit list of Ticket ids`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52" }),
        ticket({ id: "53" }),
        ticket({ id: "57" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      ids: ["52", "57"],
    });

    const frontier = await adapter.frontier();
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["52", "57"],
    );
  });

  test(`${name}: a parent root named on the frontier call narrows the Frontier to that parent's children without a selector root`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "13", parent: "8", blockedBy: ["12"] }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "8" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier({ kind: "parent", id: "8" });
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["11"],
    );
  });

  test(`${name}: a root named on the frontier call replaces the selector root`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "9" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
      parent: "8",
    });

    const frontier = await adapter.frontier({ kind: "parent", id: "9" });
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["12"],
    );
  });

  test(`${name}: an explicit list named on the frontier call bypasses the selector but not unblocked`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
        ticket({ id: "99", labels: ["other"] }),
        ticket({ id: "53", labels: ["other"], blockedBy: ["52"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier({
      kind: "list",
      ids: ["99", "53"],
    });
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["99"],
    );
  });

  test(`${name}: a list root answers the named blocked Tickets as waiting, their blockers named`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52", labels: ["ready-for-agent"] }),
        ticket({ id: "99", labels: ["other"] }),
        ticket({ id: "53", labels: ["other"], blockedBy: ["52"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const waiting = await adapter.waiting({
      kind: "list",
      ids: ["99", "53"],
    });
    assert.deepEqual(
      waiting.map((ticket) => ticket.id),
      ["53"],
    );
    assert.deepEqual(waiting[0]?.blockedBy, ["52"]);
  });

  test(`${name}: a parent root answers blocked children as waiting`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "11", parent: "8" }),
        ticket({ id: "13", parent: "8", blockedBy: ["12"] }),
        ticket({ id: "12", parent: "9" }),
        ticket({ id: "8" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const waiting = await adapter.waiting({ kind: "parent", id: "8" });
    assert.deepEqual(
      waiting.map((ticket) => ticket.id),
      ["13"],
    );
    assert.deepEqual(waiting[0]?.blockedBy, ["12"]);
  });

  test(`${name}: a nonexistent named Ticket is a lie the adapter refuses`, async () => {
    const adapter = await create({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    await assert.rejects(
      () => adapter.frontier({ kind: "list", ids: ["999"] }),
      /999/,
    );
  });

  test(`${name}: a nonexistent parent root is a lie the adapter refuses`, async () => {
    const adapter = await create({
      tickets: [ticket({ id: "52" })],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    await assert.rejects(
      () => adapter.frontier({ kind: "parent", id: "999" }),
      /999/,
    );
  });

  test(`${name}: naming is not sequencing; a list's pick order is still ascending identifier`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "57" }),
        ticket({ id: "52" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier({
      kind: "list",
      ids: ["57", "52"],
    });
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["52", "57"],
    );
  });

  test(`${name}: pick order is ascending identifier; there is no priority field on the Ticket`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "57" }),
        ticket({ id: "52" }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const frontier = await adapter.frontier();
    assert.deepEqual(
      frontier.map((ticket) => ticket.id),
      ["52", "57"],
    );
  });

  test(`${name}: leaveFrontier makes the Ticket ineligible and unblocks Tickets that were waiting on it`, async () => {
    const adapter = await create({
      tickets: [
        ticket({ id: "52" }),
        ticket({ id: "53", blockedBy: ["52"] }),
      ],
      ready: "unblocked",
      labels: ["ready-for-agent"],
    });

    const before = await adapter.frontier();
    assert.deepEqual(
      before.map((ticket) => ticket.id),
      ["52"],
    );

    const finished = before[0];
    assert.ok(finished);
    await adapter.leaveFrontier(finished, landing());

    const after = await adapter.frontier();
    assert.deepEqual(
      after.map((ticket) => ticket.id),
      ["53"],
    );
  });
}
