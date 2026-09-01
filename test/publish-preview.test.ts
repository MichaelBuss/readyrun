import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  globMatch,
  isPublishedPath,
  previewPublish,
  publishedVersions,
  type JsrPublish,
} from "../scripts/publish-preview.ts";

const publish = JSON.parse(
  await readFile(new URL("../jsr.json", import.meta.url), "utf8"),
) as { name: string; publish: JsrPublish };

test("jsr.json include/exclude decide which PR files are the published package", () => {
  assert.equal(isPublishedPath("src/init.ts", publish.publish), true);
  assert.equal(isPublishedPath("src/adapters/github.ts", publish.publish), true);
  assert.equal(isPublishedPath("README.md", publish.publish), true);
  assert.equal(isPublishedPath("LICENSE", publish.publish), true);
  assert.equal(isPublishedPath("jsr.json", publish.publish), true);
  assert.equal(isPublishedPath("src/testing/mod.ts", publish.publish), false);
  assert.equal(isPublishedPath("test/init.test.ts", publish.publish), false);
  assert.equal(isPublishedPath("docs/adr/0020-jsr-only-not-npmjs.md", publish.publish), false);
  assert.equal(isPublishedPath(".github/workflows/ci.yml", publish.publish), false);
});

test("globMatch handles jsr.json include and exclude patterns", () => {
  assert.equal(globMatch("src/**/*.ts", "src/init.ts"), true);
  assert.equal(globMatch("src/**/*.ts", "src/adapters/github.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "test/init.test.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "foo.test.ts"), true);
  assert.equal(globMatch("src/testing/**", "src/testing/mod.ts"), true);
  assert.equal(globMatch("LICENSE", "LICENSE"), true);
  assert.equal(globMatch("LICENSE", "src/LICENSE"), false);
});

test("a new version on a package-file PR is ready to ship", () => {
  const result = previewPublish({
    name: "@readyrun/readyrun",
    localVersion: "0.1.2",
    publishedVersions: ["0.1.0", "0.1.1"],
    changedFiles: ["src/init.ts", "test/init.test.ts"],
    publish: publish.publish,
  });
  assert.equal(result.willPublish, true);
  assert.equal(result.headline, "Ready to ship 0.1.2");
  assert.match(result.markdown, /Ready to ship/);
});

test("the same version with only test or docs changes has no package changes", () => {
  const result = previewPublish({
    name: "@readyrun/readyrun",
    localVersion: "0.1.1",
    publishedVersions: ["0.1.1"],
    changedFiles: ["test/init.test.ts", "docs/adr/0021-effort-optional-cli-adapter.md"],
    publish: publish.publish,
  });
  assert.equal(result.willPublish, false);
  assert.equal(result.headline, "No package changes");
});

test("the same version with published file changes is included in the next release", () => {
  const result = previewPublish({
    name: "@readyrun/readyrun",
    localVersion: "0.1.1",
    publishedVersions: ["0.1.1"],
    changedFiles: ["src/init.ts", "README.md"],
    publish: publish.publish,
  });
  assert.equal(result.willPublish, false);
  assert.equal(result.headline, "Included in the next release");
  assert.match(result.markdown, /release workflow/);
  assert.match(result.detail, /src\/init\.ts/);
});

test("publishedVersions includes latest even if versions is empty", () => {
  assert.deepEqual(publishedVersions({ latest: "0.1.1" }), ["0.1.1"]);
  assert.deepEqual(publishedVersions({ versions: { "0.1.0": {}, "0.1.1": {} } }).sort(), [
    "0.1.0",
    "0.1.1",
  ]);
});
