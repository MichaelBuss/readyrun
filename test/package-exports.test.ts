import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("jsr.json and package.json share name, version, and the cli export", async () => {
  const jsr = JSON.parse(
    await readFile(new URL("../jsr.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    exports: Record<string, string>;
  };
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    exports: Record<string, string>;
  };
  assert.equal(jsr.name, "@readyrun/readyrun");
  assert.equal(pkg.name, jsr.name);
  assert.equal(pkg.version, jsr.version);
  assert.equal(jsr.exports["."], "./src/mod.ts");
  assert.equal(jsr.exports["./cli"], "./src/cli.ts");
  assert.equal(pkg.exports["."], jsr.exports["."]);
  assert.equal(pkg.exports["./cli"], jsr.exports["./cli"]);
});
