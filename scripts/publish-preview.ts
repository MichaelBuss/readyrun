#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type JsrPublish = {
  include: readonly string[];
  exclude: readonly string[];
};

export type JsrMeta = {
  latest?: string;
  versions?: Record<string, unknown>;
};

export type PublishPreview = {
  willPublish: boolean;
  headline: string;
  detail: string;
  markdown: string;
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

export function publishedVersions(meta: JsrMeta): string[] {
  const versions = new Set(Object.keys(meta.versions ?? {}));
  if (meta.latest !== undefined && meta.latest !== "") {
    versions.add(meta.latest);
  }
  return [...versions];
}

export function previewPublish(input: {
  name: string;
  localVersion: string;
  publishedVersions: readonly string[];
  changedFiles: readonly string[];
  publish: JsrPublish;
}): PublishPreview {
  const packageFiles = input.changedFiles.filter((file) =>
    isPublishedPath(file, input.publish),
  );
  const alreadyPublished = input.publishedVersions.includes(input.localVersion);
  const pkg = `${input.name}@${input.localVersion}`;
  const fileList = formatFiles(packageFiles);

  if (!alreadyPublished) {
    const headline = `Ready to ship ${input.localVersion}`;
    const detail = `${pkg} is not on JSR yet; merging this PR will publish it.`;
    return {
      willPublish: true,
      headline,
      detail,
      markdown: `**Ready to ship.** \`${pkg}\` is not on JSR yet; merging this PR will publish it.`,
    };
  }

  if (packageFiles.length === 0) {
    const headline = "No package changes";
    const detail = `${pkg} is already on JSR, and this PR does not change published files.`;
    return {
      willPublish: false,
      headline,
      detail,
      markdown: `**No package changes.** \`${pkg}\` is already on JSR, and this PR does not change published files.`,
    };
  }

  const headline = "Will not publish until bumped";
  const detail = `${pkg} is already on JSR. Published files changed (${fileList}); merging as-is will not publish them.`;
  return {
    willPublish: false,
    headline,
    detail,
    markdown: `**Will not publish until bumped.** \`${pkg}\` is already on JSR.

Published files in this PR: ${fileList}.

No pressure — this is just informational, merging will not fail. Comment \`/bump\` (or \`/bump minor\` / \`/bump major\`) on this PR whenever you want these changes to ship, and it will push a version bump to this branch.`,
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

async function writeGithubOutput(result: PublishPreview): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (path === undefined) {
    return;
  }
  const block = [
    `headline=${result.headline}`,
    `willPublish=${result.willPublish}`,
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

export async function publishPreviewCli(argv: readonly string[]): Promise<number> {
  const jsrPath = flag(argv, "--jsr") ?? "jsr.json";
  const metaPath = flag(argv, "--meta");
  const changedPath = flag(argv, "--changed-files");
  if (metaPath === undefined || changedPath === undefined) {
    process.stderr.write(
      "Usage: node scripts/publish-preview.ts --jsr jsr.json --meta meta.json --changed-files changed.txt\n",
    );
    return 1;
  }
  const jsr = JSON.parse(await readFile(jsrPath, "utf8")) as {
    name: string;
    version: string;
    publish: JsrPublish;
  };
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as JsrMeta;
  const changedFiles = (await readFile(changedPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const result = previewPublish({
    name: jsr.name,
    localVersion: jsr.version,
    publishedVersions: publishedVersions(meta),
    changedFiles,
    publish: jsr.publish,
  });
  await writeGithubOutput(result);
  process.stdout.write(`${result.markdown}\n`);
  return 0;
}

if (isCliEntry()) {
  process.exitCode = await publishPreviewCli(process.argv.slice(2));
}
