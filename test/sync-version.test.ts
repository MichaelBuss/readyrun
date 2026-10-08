import assert from "node:assert/strict";
import { test } from "node:test";
import { syncVersions } from "../scripts/sync-version.ts";

test("jsr.json and package-lock.json follow package.json's version", () => {
  const pkg = { version: "0.2.0" };
  const jsr = { version: "0.1.5" };
  const lock = {
    version: "0.1.5",
    packages: { "": { version: "0.1.5" } },
  };
  const result = syncVersions({ pkg, jsr, lock });
  assert.deepEqual(result.changed, ["jsr.json", "package-lock.json"]);
  assert.equal(result.jsr.version, "0.2.0");
  assert.equal(lock.version, "0.2.0");
  assert.equal(lock.packages[""]?.version, "0.2.0");
});

test("a lockfile without a packages entry still gets its root version synced", () => {
  const pkg = { version: "1.0.0" };
  const jsr = { version: "1.0.0" };
  const lock = { version: "0.9.0", packages: {} };
  const result = syncVersions({ pkg, jsr, lock });
  assert.deepEqual(result.changed, ["package-lock.json"]);
  assert.equal(lock.version, "1.0.0");
});

test("an absent lockfile leaves only jsr.json to sync", () => {
  const pkg = { version: "0.3.0" };
  const jsr = { version: "0.1.5" };
  const result = syncVersions({ pkg, jsr, lock: undefined });
  assert.deepEqual(result.changed, ["jsr.json"]);
  assert.equal(result.jsr.version, "0.3.0");
});

test("everything in sync reports nothing to change", () => {
  const pkg = { version: "0.1.5" };
  const jsr = { version: "0.1.5" };
  const lock = { version: "0.1.5", packages: { "": { version: "0.1.5" } } };
  const result = syncVersions({ pkg, jsr, lock });
  assert.deepEqual(result.changed, []);
});
