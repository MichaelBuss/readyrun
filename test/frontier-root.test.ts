import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeRoot,
  parseTicketRef,
  rootViolationMessages,
  waitingNamedIds,
} from "../src/frontier-root.ts";
import { ticket } from "./tracker-adapter-contract.ts";

test("a Ticket id may be a bare id or a URL naming the Ticket", () => {
  assert.equal(parseTicketRef("53"), "53");
  assert.equal(
    parseTicketRef("https://github.com/acme/widgets/issues/53"),
    "53",
  );
  assert.equal(
    parseTicketRef("https://linear.app/acme/issue/ACME-53"),
    "ACME-53",
  );
  assert.equal(parseTicketRef(" 53 "), "53");
});

test("a URL that names no Ticket is taken verbatim rather than guessed", () => {
  assert.equal(parseTicketRef("https://github.com/acme/widgets"), "widgets");
});

test("a Ticket answered outside the named root is a violation", () => {
  const violations = rootViolationMessages(
    [ticket({ id: "52" }), ticket({ id: "31" })],
    { kind: "parent", id: "8" },
  );
  assert.deepEqual(violations, [
    "Ticket 52 is not in the named root (--root 8); the Tracker Adapter ignored the root",
    "Ticket 31 is not in the named root (--root 8); the Tracker Adapter ignored the root",
  ]);
});

test("a list answer outside the named list is a violation", () => {
  const violations = rootViolationMessages(
    [ticket({ id: "52" }), ticket({ id: "53" })],
    { kind: "list", ids: ["52"] },
  );
  assert.deepEqual(violations, [
    "Ticket 53 is not in the named root (--ticket 52); the Tracker Adapter ignored the root",
  ]);
});

test("named Tickets missing from the answer are waiting work", () => {
  const waiting = waitingNamedIds([ticket({ id: "52" })], {
    kind: "list",
    ids: ["52", "53"],
  });
  assert.deepEqual(waiting, ["53"]);
});

test("a parent root names no waiting Tickets; the caller cannot see its children", () => {
  const waiting = waitingNamedIds([], { kind: "parent", id: "8" });
  assert.deepEqual(waiting, []);
});

test("the root is described the way the command line named it", () => {
  assert.equal(describeRoot({ kind: "parent", id: "8" }), "--root 8");
  assert.equal(describeRoot({ kind: "list", ids: ["52", "53"] }), "--ticket 52 53");
});
