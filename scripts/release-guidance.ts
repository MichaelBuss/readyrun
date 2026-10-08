#!/usr/bin/env node
// The release-guidance comment: one comment per PR, updated in place, that
// tells a human (or an AFK agent) what will ship, at which bump kind, whether
// a changeset is present, and whether the body closes an issue. Informational
// only — it never fails a PR, the same philosophy that killed the merge gate
// in ADR 0024.

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type JsrPublish = {
  include: readonly string[];
  exclude: readonly string[];
};

export type BumpKind = "patch" | "minor" | "major";

export type ChangesetEntry = {
  package: string;
  kind: BumpKind;
  note: string;
};

export function globMatch(pattern: string, file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  let rest = pattern;
  let source = "^";
  while (rest.length > 0) {
    if (rest.startsWith("**/")) {
      source += "(?:.*/)?";
      rest = rest.slice(3);
      continue;
    }
    if (rest === "**") {
      source += ".*";
      rest = "";
      continue;
    }
    if (rest.startsWith("**")) {
      source += ".*";
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("*")) {
      source += "[^/]*";
      rest = rest.slice(1);
      continue;
    }
    const ch = rest.at(0);
    if (ch === undefined) {
      break;
    }
    source += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    rest = rest.slice(1);
  }
  return new RegExp(`${source}$`).test(normalized);
}

export function isPublishedPath(file: string, publish: JsrPublish): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const included = publish.include.some((pattern) => globMatch(pattern, normalized));
  if (!included) {
    return false;
  }
  return !publish.exclude.some((pattern) => globMatch(pattern, normalized));
}

export function parseChangeset(content: string): ChangesetEntry[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) {
    return [];
  }
  const [, frontmatter = "", body = ""] = match;
  const entries: ChangesetEntry[] = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const entry = /^\s*["']?([^"':]+)["']?:\s*(patch|minor|major)\s*$/.exec(line);
    if (entry !== null) {
      entries.push({
        package: entry[1]!.trim(),
        kind: entry[2] as BumpKind,
        note: body.trim(),
      });
    }
  }
  return entries;
}

export function closesIssue(body: string): boolean {
  return /\b(closes?|fixes?|resolves?)\s*:?\s+#\d+/i.test(body);
}

export type Guidance = {
  headline: string;
  detail: string;
  markdown: string;
};

export function guidance(input: {
  changedFiles: readonly string[];
  publish: JsrPublish;
  package: string;
  changesets: readonly ChangesetEntry[];
  closesIssue: boolean;
}): Guidance {
  const packageFiles = input.changedFiles.filter((file) =>
    isPublishedPath(file, input.publish),
  );
  const own = input.changesets.filter((entry) => entry.package === input.package);
  const lines: string[] = [];

  if (packageFiles.length === 0) {
    lines.push("**No published files change in this PR.**");
  } else {
    lines.push(`**Published files change:** ${formatFiles(packageFiles)}`);
  }

  if (own.length > 0) {
    lines.push("");
    lines.push("**Changeset** (what the release notes will say):");
    lines.push("");
    for (const entry of own) {
      lines.push(`- \`${entry.package}\`: **${entry.kind}** — ${entry.note}`);
    }
  } else if (packageFiles.length === 0) {
    lines.push("**No changeset**, and none needed.");
  } else {
    lines.push("");
    lines.push(
      "**No changeset yet — none of these changes will ship when this merges.** Add one with `npm run changeset`: pick `patch` for fixes (the usual default), `minor` for new features, `major` for breaking changes, and write a note worth reading in a changelog.",
    );
  }

  if (input.closesIssue) {
    lines.push("");
    lines.push("The body closes an issue, so the release notes can link it.");
  } else {
    lines.push("");
    lines.push(
      "Nudge: the body doesn't close an issue. If this PR resolves one, adding `Closes #123` (its real number) links the release notes and the tracker together — never a gate, just a kindness to future readers.",
    );
  }

  const markdown = lines.join("\n");
  const headline =
    packageFiles.length === 0
      ? "No published files change in this PR"
      : own.length > 0
        ? `Changeset: ${own.map((entry) => `${entry.kind} for ${entry.package}`).join("; ")}`
        : "Published files change without a changeset";
  return {
    headline,
    detail: headline,
    markdown,
  };
}

function formatFiles(files: readonly string[]): string {
  if (files.length <= 8) {
    return files.join(", ");
  }
  const shown = files.slice(0, 8).join(", ");
  return `${shown}, and ${files.length - 8} more`;
}

function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

async function writeGithubOutput(result: Guidance): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (path === undefined) {
    return;
  }
  const block = [
    `headline=${result.headline}`,
    "detail<<EOF",
    result.detail,
    "EOF",
    "markdown<<EOF",
    result.markdown,
    "EOF",
    "",
  ].join("\n");
  await writeFile(path, block, { flag: "a" });
}

export async function releaseGuidanceCli(argv: readonly string[]): Promise<number> {
  const jsrPath = flag(argv, "--jsr") ?? "jsr.json";
  const changedPath = flag(argv, "--changed-files");
  const body = flag(argv, "--pr-body") ?? process.env.PR_BODY ?? "";
  if (changedPath === undefined) {
    process.stderr.write(
      "Usage: node scripts/release-guidance.ts --jsr jsr.json --changed-files changed.txt [--pr-body body.md]\n",
    );
    return 1;
  }
  const jsr = JSON.parse(await readFile(jsrPath, "utf8")) as {
    name: string;
    publish: JsrPublish;
  };
  const changedFiles = (await readFile(changedPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const changesets: ChangesetEntry[] = [];
  for (const file of changedFiles) {
    if (!/^\.changeset\/[^/]+\.md$/.test(file) || file.endsWith("README.md")) {
      continue;
    }
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    changesets.push(...parseChangeset(content));
  }
  const result = guidance({
    changedFiles,
    publish: jsr.publish,
    package: jsr.name,
    changesets,
    closesIssue: closesIssue(body),
  });
  await writeGithubOutput(result);
  process.stdout.write(`${result.markdown}\n`);
  return 0;
}

if (isCliEntry()) {
  process.exitCode = await releaseGuidanceCli(process.argv.slice(2));
}
