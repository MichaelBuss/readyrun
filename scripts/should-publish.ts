#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishedVersions, type JsrMeta } from "./publish-preview.ts";

export async function shouldPublish(
  jsrPath: string,
  metaPath: string,
): Promise<{ version: string; alreadyPublished: boolean }> {
  const jsr = JSON.parse(await readFile(jsrPath, "utf8")) as { version: string };
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as JsrMeta;
  return {
    version: jsr.version,
    alreadyPublished: publishedVersions(meta).includes(jsr.version),
  };
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

export async function shouldPublishCli(argv: readonly string[]): Promise<number> {
  const jsrPath = flag(argv, "--jsr") ?? "jsr.json";
  const metaPath = flag(argv, "--meta");
  if (metaPath === undefined) {
    process.stderr.write(
      "Usage: node scripts/should-publish.ts --jsr jsr.json --meta meta.json\n",
    );
    return 1;
  }
  const { version, alreadyPublished } = await shouldPublish(jsrPath, metaPath);
  const path = process.env.GITHUB_OUTPUT;
  if (path !== undefined) {
    await writeFile(
      path,
      `shouldPublish=${!alreadyPublished}\nversion=${version}\n`,
      { flag: "a" },
    );
  }
  process.stdout.write(
    alreadyPublished
      ? `${version} is already on JSR; nothing to publish.\n`
      : `${version} is not on JSR yet; publishing.\n`,
  );
  return 0;
}

if (isCliEntry()) {
  process.exitCode = await shouldPublishCli(process.argv.slice(2));
}
