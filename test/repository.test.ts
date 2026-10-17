import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeRepository,
  parseOwnerRepo,
  stripRepoDecorations,
} from "../src/repository.ts";

test("parseOwnerRepo is owner/name from an ssh URL", () => {
  assert.equal(parseOwnerRepo("git@github.com:Acme/Widgets.git"), "Acme/Widgets");
});

test("parseOwnerRepo is owner/name from an https URL", () => {
  assert.equal(
    parseOwnerRepo("https://github.com/Acme/Widgets.git"),
    "Acme/Widgets",
  );
});

test("parseOwnerRepo is undefined for a bare owner/name, which is no URL", () => {
  assert.equal(parseOwnerRepo("Acme/Widgets"), undefined);
});

test("parseOwnerRepo is undefined for a value with no owner/name tail", () => {
  assert.equal(parseOwnerRepo("not-a-repo"), undefined);
});

test("normalizeRepository lowercases and sheds decorations", () => {
  assert.equal(normalizeRepository("Acme/Widgets.GIT/"), "acme/widgets");
});

test("stripRepoDecorations sheds whitespace, trailing slashes, and the .git suffix, preserving case", () => {
  assert.equal(stripRepoDecorations("  Acme/Widgets.git/  "), "Acme/Widgets");
});
