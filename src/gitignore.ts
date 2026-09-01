import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const readyrunEntry = ".readyrun/";

async function readGitignore(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const wildcarded = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${wildcarded}$`);
}

// Exact .readyrun/ line, or a `*`/`?` wildcard against the same basename
// (.ready*, .*). Nested-path patterns and gitignore's [...] character
// classes are treated as not covering it — out of scope for this check.
function coversReadyrunDir(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return false;
  }
  const unanchored = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const dirless = unanchored.endsWith("/") ? unanchored.slice(0, -1) : unanchored;
  if (dirless.length === 0 || dirless.includes("/")) {
    return false;
  }
  return globToRegExp(dirless).test(".readyrun");
}

export async function ensureReadyrunGitignored(cwd: string): Promise<void> {
  const path = resolve(cwd, ".gitignore");
  const existing = await readGitignore(path);
  if (existing === undefined) {
    await writeFile(path, `${readyrunEntry}\n`);
    return;
  }
  if (existing.split(/\r?\n/).some(coversReadyrunDir)) {
    return;
  }
  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  await writeFile(path, `${existing}${needsNewline ? "\n" : ""}${readyrunEntry}\n`);
}
