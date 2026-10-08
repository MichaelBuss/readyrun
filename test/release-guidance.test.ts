import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  closesIssue,
  globMatch,
  guidance,
  isPublishedPath,
  parseChangeset,
  type ChangesetEntry,
  type JsrPublish,
} from "../scripts/release-guidance.ts";

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

test("parseChangeset reads the standard frontmatter form", () => {
  const entries = parseChangeset(`---
"@readyrun/readyrun": minor
---
Doctor now probes a Worker Adapter before a Run starts.
`);
  assert.deepEqual(entries, [
    {
      package: "@readyrun/readyrun",
      kind: "minor",
      note: "Doctor now probes a Worker Adapter before a Run starts.",
    } satisfies ChangesetEntry,
  ]);
});

test("parseChangeset accepts an unquoted package name and a multi-line note", () => {
  const entries = parseChangeset(`---
readyrun: patch
---
First line.

Second line.
`);
  assert.equal(entries[0]?.kind, "patch");
  assert.match(entries[0]?.note ?? "", /First line\./);
  assert.match(entries[0]?.note ?? "", /Second line\./);
});

test("parseChangeset returns nothing for a file without frontmatter", () => {
  assert.deepEqual(parseChangeset("just some notes"), []);
});

test("closesIssue detects the closing keywords, not mere references", () => {
  assert.equal(closesIssue("Closes #54"), true);
  assert.equal(closesIssue("fixes #12"), true);
  assert.equal(closesIssue("resolves: #7"), true);
  assert.equal(closesIssue("Closed #3 in that PR"), true);
  assert.equal(closesIssue("Fixed #9"), true);
  assert.equal(closesIssue("refs #12"), false);
  assert.equal(closesIssue(""), false);
});

function guidanceMarkdown(input: {
  changedFiles: readonly string[];
  changesets: readonly ChangesetEntry[];
  body: string;
}): string {
  return guidance({
    changedFiles: input.changedFiles,
    publish: publish.publish,
    package: publish.name,
    changesets: input.changesets,
    closesIssue: closesIssue(input.body),
  }).markdown;
}

test("a PR with published changes and a changeset shows the bump and the note", () => {
  const markdown = guidanceMarkdown({
    changedFiles: ["src/init.ts"],
    changesets: [
      { package: publish.name, kind: "minor", note: "Doctor probes the Worker Adapter." },
    ],
    body: "Closes #54",
  });
  assert.match(markdown, /src\/init\.ts/);
  assert.match(markdown, /minor/);
  assert.match(markdown, /Doctor probes the Worker Adapter\./);
  assert.doesNotMatch(markdown, /No changeset/);
  assert.doesNotMatch(markdown, /doesn't close an issue|does not close an issue/i);
});

test("a PR with published changes and no changeset is told what will not ship and how to add one", () => {
  const markdown = guidanceMarkdown({
    changedFiles: ["src/mod.ts"],
    changesets: [],
    body: "",
  });
  assert.match(markdown, /No changeset/);
  assert.match(markdown, /npm run changeset/);
  assert.match(markdown, /Assumed bump.*\*\*patch\*\*/);
});

test("a PR with no published changes needs no changeset and says so", () => {
  const markdown = guidanceMarkdown({
    changedFiles: ["test/init.test.ts", "docs/adr/0021-effort-optional-cli-adapter.md"],
    changesets: [],
    body: "",
  });
  assert.match(markdown, /No published files/);
  assert.match(markdown, /No changeset/);
  assert.match(markdown, /none needed/);
});

test("a PR whose body closes nothing gets a nudge, not a gate", () => {
  const markdown = guidanceMarkdown({
    changedFiles: ["src/init.ts"],
    changesets: [
      { package: publish.name, kind: "patch", note: "Fix." },
    ],
    body: "just a fix",
  });
  assert.match(markdown, /Closes #\d+/);
  assert.match(markdown, /nudge|consider|if it resolves/i);
});
