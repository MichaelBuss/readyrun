import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { before, test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await tsFilesUnder(path)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

before(async () => {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    build.status,
    0,
    `tsc -p tsconfig.build.json failed:\n${build.stderr}`,
  );
});

test("the build emits compiled JS with a shebang for the bin", async () => {
  const cli = await readFile(join(root, "dist", "cli.js"), "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node"), "dist/cli.js keeps the shebang");
  await stat(join(root, "dist", "mod.js"));
});

test("the build emits declarations next to the compiled entries", async () => {
  await stat(join(root, "dist", "mod.d.ts"));
  await stat(join(root, "dist", "cli.d.ts"));
});

test("dist ships no TypeScript and no test helpers", async () => {
  const dist = join(root, "dist");
  assert.deepEqual(await tsFilesUnder(dist), []);
  await assert.rejects(stat(join(dist, "testing")), "src/testing must not compile into dist");
});

test("package.json entry points resolve to files the build emitted", async () => {
  const pkg = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    bin: Record<string, string>;
    exports: Record<string, string>;
  };
  for (const target of [...Object.values(pkg.bin), ...Object.values(pkg.exports)]) {
    await stat(join(root, target));
  }
});
