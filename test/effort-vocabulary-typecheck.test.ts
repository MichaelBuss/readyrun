import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsc = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

// The config's effort field is typed against the chosen Adapter's declared
// vocabulary (ADR 0042). The fixture writes one config per line: unmarked
// lines must compile, and every @ts-expect-error line must actually fail —
// an unused directive is its own error, so tsc exiting 0 proves both halves.
const fixture = (mod: string, testing: string) => `import { claude, cursor, custom, opencode, defineConfig } from ${JSON.stringify(mod)};
import { memoryTracker } from ${JSON.stringify(testing)};

const tracker = memoryTracker({ tickets: [], ready: "unblocked", labels: [] });

defineConfig({ tracker, worker: claude(), model: "m", effort: "max" });
defineConfig({ tracker, worker: custom({ bin: "b", unattendedFlag: "--u", effortFlag: "--e", effortVocabulary: ["high"] }), model: "m", effort: "high" });
defineConfig({ tracker, worker: opencode(), model: "m", effort: "max" });
// @ts-expect-error cursor declares no Effort vocabulary
defineConfig({ tracker, worker: cursor(), model: "m", effort: "high" });
// @ts-expect-error "yolo" is outside Claude's declared vocabulary
defineConfig({ tracker, worker: claude(), model: "m", effort: "yolo" });
// @ts-expect-error opencode declares only high | max
defineConfig({ tracker, worker: opencode(), model: "m", effort: "low" });
// @ts-expect-error a custom Adapter without a declaration maps no Effort
defineConfig({ tracker, worker: custom({ bin: "b", unattendedFlag: "--u" }), model: "m", effort: "high" });
// @ts-expect-error only declared values pass a declared vocabulary
defineConfig({ tracker, worker: custom({ bin: "b", unattendedFlag: "--u", effortFlag: "--e", effortVocabulary: ["high"] }), model: "m", effort: "max" });
`;

test("a config Effort outside the chosen Adapter's declared vocabulary fails to typecheck", async () => {
  const dir = await mkdtemp(join(repoRoot, "test", ".effort-vocabulary-"));
  try {
    const path = join(dir, "fixture.mts");
    await writeFile(
      path,
      fixture(
        join(repoRoot, "src", "mod.ts"),
        join(repoRoot, "src", "testing", "mod.ts"),
      ),
    );
    // Exit code 0 is the assertion: every @ts-expect-error found its error,
    // and nothing else failed.
    await exec(process.execPath, [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--allowImportingTsExtensions",
      "--skipLibCheck",
      path,
    ], { cwd: repoRoot });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
