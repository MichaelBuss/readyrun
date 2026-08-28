import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTrackerOptions } from "../src/testing/memory-tracker.ts";
import type { Ticket } from "../src/ticket.ts";
import type { TrackerAdapter } from "../src/tracker-adapter.ts";

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
    await adapter.leaveFrontier(finished);

    const after = await adapter.frontier();
    assert.deepEqual(
      after.map((ticket) => ticket.id),
      ["53"],
    );
  });
}
