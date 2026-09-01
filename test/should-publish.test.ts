import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { shouldPublish } from "../scripts/should-publish.ts";

const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");

test("shouldPublish is true when the local version is not on JSR yet", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "should-publish-"));
  try {
    const jsrPath = join(root, "jsr.json");
    const metaPath = join(root, "meta.json");
    await writeFile(jsrPath, JSON.stringify({ version: "0.1.2" }));
    await writeFile(metaPath, JSON.stringify({ latest: "0.1.1", versions: { "0.1.1": {} } }));
    assert.deepEqual(await shouldPublish(jsrPath, metaPath), {
      version: "0.1.2",
      alreadyPublished: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shouldPublish is false when the local version is already on JSR", async () => {
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "should-publish-"));
  try {
    const jsrPath = join(root, "jsr.json");
    const metaPath = join(root, "meta.json");
    await writeFile(jsrPath, JSON.stringify({ version: "0.1.1" }));
    await writeFile(metaPath, JSON.stringify({ latest: "0.1.1", versions: { "0.1.1": {} } }));
    assert.deepEqual(await shouldPublish(jsrPath, metaPath), {
      version: "0.1.1",
      alreadyPublished: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
