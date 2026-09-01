import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bump,
  BumpError,
  extractBaseline,
  higherVersion,
  nextVersion,
  parseBumpSpec,
} from "../scripts/bump.ts";

const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

async function writeVersionFiles(root: string, version: string): Promise<void> {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@readyrun/readyrun", version }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "jsr.json"),
    `${JSON.stringify({ name: "@readyrun/readyrun", version }, null, 2)}\n`,
  );
}

test("nextVersion increments patch, minor, and major", () => {
  assert.equal(nextVersion("0.1.1", "patch"), "0.1.2");
  assert.equal(nextVersion("0.1.1"), "0.1.2");
  assert.equal(nextVersion("0.1.1", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.1", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.1", "0.3.0"), "0.3.0");
});

test("nextVersion refuses the current version and non-semver", () => {
  assert.throws(() => nextVersion("0.1.1", "0.1.1"), BumpError);
  assert.throws(() => nextVersion("0.1.1", "1"), BumpError);
  assert.throws(() => nextVersion("v0.1.1", "patch"), BumpError);
});

test("parseBumpSpec defaults to patch and accepts flags or an exact version", () => {
  assert.equal(parseBumpSpec([]), "patch");
  assert.equal(parseBumpSpec(["minor"]), "minor");
  assert.equal(parseBumpSpec(["--major"]), "major");
  assert.equal(parseBumpSpec(["0.2.0"]), "0.2.0");
  assert.throws(() => parseBumpSpec(["patch", "minor"]), BumpError);
  assert.throws(() => parseBumpSpec(["--help"]), BumpError);
});

test("bump writes the same version to package.json, jsr.json, and the lockfile", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "bump-"));
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "@readyrun/readyrun", version: "0.1.1" }, null, 2)}\n`,
    );
    await writeFile(
      join(root, "jsr.json"),
      `${JSON.stringify({ name: "@readyrun/readyrun", version: "0.1.1" }, null, 2)}\n`,
    );
    await writeFile(
      join(root, "package-lock.json"),
      `${JSON.stringify({
        name: "@readyrun/readyrun",
        version: "0.1.1",
        lockfileVersion: 3,
        packages: { "": { name: "@readyrun/readyrun", version: "0.1.1" } },
      }, null, 2)}\n`,
    );
    const result = await bump(root, "patch");
    assert.deepEqual(result, { from: "0.1.1", to: "0.1.2" });
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    const jsr = JSON.parse(await readFile(join(root, "jsr.json"), "utf8")) as {
      version: string;
    };
    const lock = JSON.parse(
      await readFile(join(root, "package-lock.json"), "utf8"),
    ) as { version: string; packages: { "": { version: string } } };
    assert.equal(pkg.version, "0.1.2");
    assert.equal(jsr.version, "0.1.2");
    assert.equal(lock.version, "0.1.2");
    assert.equal(lock.packages[""].version, "0.1.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractBaseline pulls --baseline out of argv, leaving the rest untouched", () => {
  assert.deepEqual(extractBaseline([]), { rest: [] });
  assert.deepEqual(extractBaseline(["minor"]), { rest: ["minor"] });
  assert.deepEqual(extractBaseline(["minor", "--baseline", "0.1.5"]), {
    rest: ["minor"],
    baseline: "0.1.5",
  });
  assert.deepEqual(extractBaseline(["--baseline", "0.1.5", "minor"]), {
    rest: ["minor"],
    baseline: "0.1.5",
  });
  assert.throws(() => extractBaseline(["--baseline"]), BumpError);
});

test("higherVersion picks the greater of two semvers", () => {
  assert.equal(higherVersion("0.1.1", "0.1.2"), "0.1.2");
  assert.equal(higherVersion("0.2.0", "0.1.9"), "0.2.0");
  assert.equal(higherVersion("1.0.0", "0.9.9"), "1.0.0");
  assert.equal(higherVersion("0.1.1", "0.1.1"), "0.1.1");
});

test("bump uses the baseline when a branch's own version is stale", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "bump-"));
  try {
    await writeVersionFiles(root, "0.1.1");
    const result = await bump(root, "patch", "0.1.5");
    assert.deepEqual(result, { from: "0.1.1", to: "0.1.6" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bump ignores a baseline that is behind the branch's own version", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "bump-"));
  try {
    await writeVersionFiles(root, "0.2.0");
    const result = await bump(root, "patch", "0.1.5");
    assert.deepEqual(result, { from: "0.2.0", to: "0.2.1" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bump refuses when package.json and jsr.json already disagree", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "bump-"));
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ version: "0.1.1" }, null, 2)}\n`,
    );
    await writeFile(
      join(root, "jsr.json"),
      `${JSON.stringify({ version: "0.1.0" }, null, 2)}\n`,
    );
    await assert.rejects(() => bump(root, "patch"), BumpError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
