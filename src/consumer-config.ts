import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReadyRunConfig } from "./config.ts";

const configNames = [
  "readyrun.config.ts",
  "readyrun.config.js",
  "readyrun.config.mjs",
] as const;

/** No config file at the Consumer root, under any accepted name. */
export class ConfigNotFoundError extends Error {
  constructor() {
    super(
      "No readyrun.config.ts, readyrun.config.js, or readyrun.config.mjs at the Consumer root. Run `readyrun init`.",
    );
    this.name = "ConfigNotFoundError";
  }
}

/** More than one accepted config name at the Consumer root. */
export class AmbiguousConfigError extends Error {
  constructor(names: readonly string[]) {
    super(
      `Multiple config files at the Consumer root: ${names.join(", ")}. Leave one file.`,
    );
    this.name = "AmbiguousConfigError";
  }
}

/** The config file exists but does not default-export `defineConfig(...)`. */
export class ConfigExportError extends Error {
  constructor(name: string) {
    super(
      `${name} must default-export defineConfig(...). Default-export defineConfig(...) from that file.`,
    );
    this.name = "ConfigExportError";
  }
}

/** The one-line message for a config-load failure, whatever threw. */
export function configLoadFailure(error: unknown): string {
  if (
    error instanceof ConfigNotFoundError ||
    error instanceof AmbiguousConfigError ||
    error instanceof ConfigExportError
  ) {
    return error.message;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load the ReadyRun config. Fix the config file. ${detail}`;
}

/**
 * Load the Consumer's `readyrun.config.ts` (or `.js`/`.mjs`) from its
 * default export. Refuses when no file is there, when more than one
 * accepted name is, and when the file does not default-export
 * `defineConfig(...)`.
 */
export async function loadConfig(cwd: string): Promise<ReadyRunConfig> {
  const found = configNames.filter((name) => existsSync(join(cwd, name)));
  if (found.length === 0) {
    throw new ConfigNotFoundError();
  }
  if (found.length > 1) {
    throw new AmbiguousConfigError(found);
  }
  const name = found[0];
  if (name === undefined) {
    throw new ConfigNotFoundError();
  }
  const mod: { default?: ReadyRunConfig } = await import(
    pathToFileURL(join(cwd, name)).href
  );
  if (mod.default === undefined) {
    throw new ConfigExportError(name);
  }
  return mod.default;
}
