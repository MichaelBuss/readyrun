import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNpmAlreadyPublished,
  isNpmSetupError,
  npmSetupInstructions,
  planRelease,
  publishedVersions,
  type JsrMeta,
} from "../scripts/release.ts";

test("a version on neither registry publishes to both", () => {
  assert.deepEqual(
    planRelease({ version: "0.2.0", npmVersions: [], jsrVersions: ["0.1.5"] }),
    { npm: true, jsr: true },
  );
});

test("a version already on npm is not re-published there", () => {
  assert.deepEqual(
    planRelease({ version: "0.2.0", npmVersions: ["0.2.0"], jsrVersions: [] }),
    { npm: false, jsr: true },
  );
});

test("a version already on JSR is not re-published there", () => {
  assert.deepEqual(
    planRelease({ version: "0.2.0", npmVersions: [], jsrVersions: ["0.2.0", "0.1.5"] }),
    { npm: true, jsr: false },
  );
});

test("a version on both registries publishes nothing", () => {
  assert.deepEqual(
    planRelease({ version: "0.1.5", npmVersions: ["0.1.5"], jsrVersions: ["0.1.5"] }),
    { npm: false, jsr: false },
  );
});

test("publishedVersions includes latest even if versions is empty", () => {
  assert.deepEqual(publishedVersions({ latest: "0.1.1" }), ["0.1.1"]);
  assert.deepEqual(publishedVersions({ versions: { "0.1.0": {}, "0.1.1": {} } }).sort(), [
    "0.1.0",
    "0.1.1",
  ]);
});

test("registry rejections that a human must fix count as setup errors", () => {
  assert.equal(isNpmSetupError("npm error 404 Not Found - Package name not found"), true);
  assert.equal(
    isNpmSetupError("npm error 403 Forbidden - You do not have permission to publish"),
    true,
  );
  assert.equal(isNpmSetupError("npm error code ENEEDAUTH"), true);
  assert.equal(isNpmSetupError("npm error 402 Payment Required"), true);
});

test("transient npm failures are not setup errors", () => {
  assert.equal(isNpmSetupError("npm error network ECONNRESET"), false);
  assert.equal(isNpmSetupError("npm error ETIMEDOUT"), false);
  assert.equal(isNpmSetupError("npm error 500 Internal Server Error"), false);
});

test("an already-published race is recognized, not misread as a setup problem", () => {
  const stderr = "npm error 409 Conflict - Cannot publish over the previously published versions: 0.2.0.";
  assert.equal(isNpmAlreadyPublished(stderr), true);
  assert.equal(isNpmSetupError(stderr), false);
});

test("the setup instructions name the scope, trusted publishing, and the re-run", () => {
  const text = npmSetupInstructions("@readyrun/readyrun", "0.2.0");
  assert.match(text, /npmjs\.com/);
  assert.match(text, /@readyrun/);
  assert.match(text, /trusted publishing/i);
  assert.match(text, /re-run/i);
});
