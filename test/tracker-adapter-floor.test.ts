import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingProbeOnce,
  paginate,
  pickOrder,
} from "../src/tracker-adapter-floor.ts";
import { ticket } from "./tracker-adapter-contract.ts";

test("pickOrder is the numeric Ticket id ascending, so naming never sequences", () => {
  const tickets = [
    ticket({ id: "57" }),
    ticket({ id: "10" }),
    ticket({ id: "9" }),
    ticket({ id: "52" }),
  ];
  assert.deepEqual(
    [...tickets].sort(pickOrder).map((ticket) => ticket.id),
    ["9", "10", "52", "57"],
  );
});

test("paginate reads every page once, in page order, and skips null nodes", async () => {
  const pages = [
    {
      pageInfo: { hasNextPage: true, endCursor: "c1" },
      nodes: ["a", null, "b"],
    },
    { pageInfo: { hasNextPage: true, endCursor: "c2" }, nodes: [] },
    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ["c", null] },
  ];
  const cursors: (string | null)[] = [];
  const nodes = await paginate<string>((cursor) => {
    cursors.push(cursor);
    const page = pages[cursors.length - 1];
    assert.ok(page !== undefined);
    return Promise.resolve(page);
  });
  assert.deepEqual(nodes, ["a", "b", "c"]);
  assert.deepEqual(cursors, [null, "c1", "c2"]);
});

test("the blocking probe is read once per transport and scope per process", async () => {
  let reads = 0;
  const probe = () => {
    reads += 1;
    return Promise.resolve(true);
  };
  const transport = {};
  assert.equal(await blockingProbeOnce(transport, "acme/widgets", probe), true);
  assert.equal(await blockingProbeOnce(transport, "acme/widgets", probe), true);
  assert.equal(reads, 1);
  // A different repo and a different transport each read for themselves.
  assert.equal(await blockingProbeOnce(transport, "other/repo", probe), true);
  assert.equal(reads, 2);
  assert.equal(await blockingProbeOnce({}, "acme/widgets", probe), true);
  assert.equal(reads, 3);
});

test("a failed probe is not an answer; the next read probes again", async () => {
  let reads = 0;
  const transport = {};
  const flaky = () => {
    reads += 1;
    return reads === 1
      ? Promise.reject(new Error("Tracker unreachable"))
      : Promise.resolve(true);
  };
  await assert.rejects(
    () => blockingProbeOnce(transport, "acme/widgets", flaky),
    /unreachable/,
  );
  assert.equal(await blockingProbeOnce(transport, "acme/widgets", flaky), true);
  assert.equal(reads, 2);
});
