import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("the compiled bin runs on stock Node: usage without type stripping", () => {
  const help = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 1, `dist/cli.js --help crashed:\n${help.stderr}`);
  assert.ok(help.stdout.includes("Usage: readyrun <command>"));
  assert.ok(!help.stderr.includes("ERR_UNSUPPORTED"), help.stderr);
});

test("the compiled module imports on stock Node", async () => {
  const mod = await import(pathToFileURL(join(root, "dist", "mod.js")).href);
  assert.equal(typeof mod.defineConfig, "function");
  assert.equal(typeof mod.github, "function");
  assert.equal(typeof mod.claude, "function");
});

test("a TS consumer against dist resolves types with moduleResolution bundler", async () => {
  const consumer = join(root, "test", ".tmp", "npm-artifact-consumer");
  await rm(consumer, { recursive: true, force: true });
  await mkdir(join(consumer, "node_modules", "@readyrun"), { recursive: true });
  await symlink(root, join(consumer, "node_modules", "@readyrun", "readyrun"), "dir");
  await writeFile(
    join(consumer, "consumer.ts"),
    [
      'import { defineConfig, github, claude } from "@readyrun/readyrun";',
      "export default defineConfig({",
      '  tracker: github({ repo: "owner/name", ready: "unblocked", labels: ["x"] }),',
      "  worker: claude(),",
      '  model: "sonnet",',
      '  permissions: "unattended",',
      "});",
      "",
    ].join("\n"),
  );
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const check = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "consumer.ts",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  assert.equal(
    check.status,
    0,
    `consumer typecheck failed against shipped types:\n${check.stdout}${check.stderr}`,
  );
});
