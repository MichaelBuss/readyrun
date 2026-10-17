import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("jsr.json and package.json share name and version; npm ships compiled JS while JSR ships sources", async () => {
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
    bin: Record<string, string>;
    exports: Record<string, string>;
    files: string[];
  };
  assert.equal(jsr.name, "@readyrun/readyrun");
  assert.equal(pkg.name, jsr.name);
  assert.equal(pkg.version, jsr.version);

  // JSR publishes TypeScript sources; npm must not: Node refuses to strip
  // types under node_modules, so npm entry points point at compiled JS.
  assert.equal(jsr.exports["."], "./src/mod.ts");
  assert.equal(jsr.exports["./cli"], "./src/cli.ts");
  assert.equal(pkg.exports["."], "./dist/mod.js");
  assert.equal(pkg.exports["./cli"], "./dist/cli.js");
  assert.equal(pkg.bin["readyrun"], "dist/cli.js");
  assert.match(pkg.exports["."], /\.js$/);
  assert.match(pkg.exports["./cli"], /\.js$/);

  // The npm tarball ships the compiled output, not the sources.
  assert.ok(pkg.files.includes("dist"), "files must include dist");
  assert.ok(!pkg.files.includes("src"), "files must not ship src");
});
