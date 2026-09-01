import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configWrittenMessage, init, parseListedModels, type InitAnswers } from "../src/init.ts";

const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");
const packageHref = pathToFileURL(
  join(fileURLToPath(new URL(".", import.meta.url)), "../src/mod.ts"),
).href;

const githubCursorAnswers: InitAnswers = {
  tracker: {
    kind: "github",
    repo: "acme/widgets",
    labels: ["ready-for-agent"],
  },
  worker: { kind: "cursor" },
  model: "composer-2",
};

const githubCursorStub = `import { defineConfig, github, cursor } from "@readyrun/readyrun";

export default defineConfig({
  tracker: github({
    repo: "acme/widgets",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: cursor(),
  model: "composer-2",
});
`;

const linearClaudeAnswers: InitAnswers = {
  tracker: {
    kind: "linear",
    label: "ready-for-agent",
  },
  worker: { kind: "claude" },
  model: "opus",
  effort: "high",
};

const linearClaudeStub = `import { defineConfig, linear, claude } from "@readyrun/readyrun";

export default defineConfig({
  tracker: linear({
    ready: "unblocked",
    label: "ready-for-agent",
  }),
  worker: claude(),
  model: "opus",
  effort: "high",
});
`;

const githubCustomAnswers: InitAnswers = {
  tracker: {
    kind: "github",
    repo: "acme/widgets",
    labels: ["ready-for-agent"],
  },
  worker: {
    kind: "custom",
    bin: "my-agent",
    unattendedFlag: "--dangerously-skip-permissions",
  },
  model: "local-model",
};

const githubCustomStub = `import { defineConfig, github, custom } from "@readyrun/readyrun";

export default defineConfig({
  tracker: github({
    repo: "acme/widgets",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: custom({
    bin: "my-agent",
    unattendedFlag: "--dangerously-skip-permissions",
  }),
  model: "local-model",
});
`;

const linearStateAnswers: InitAnswers = {
  tracker: { kind: "linear", state: "Ready" },
  worker: { kind: "cursor" },
  model: "composer-2",
};

const linearStateStub = `import { defineConfig, linear, cursor } from "@readyrun/readyrun";

export default defineConfig({
  tracker: linear({
    ready: "unblocked",
    state: "Ready",
  }),
  worker: cursor(),
  model: "composer-2",
});
`;

async function withConsumerRoot(
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, "init-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function loadStub(cwd: string): Promise<void> {
  const path = join(cwd, "readyrun.config.ts");
  const source = await readFile(path, "utf8");
  const loadable = source.replaceAll(
    '"@readyrun/readyrun"',
    JSON.stringify(packageHref),
  );
  await writeFile(path, loadable);
  await import(pathToFileURL(path).href);
}

async function assertWrittenStub(
  answers: InitAnswers,
  expected: string,
): Promise<void> {
  await withConsumerRoot(async (cwd) => {
    const exitCode = await init({ cwd, answers });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(cwd, "readyrun.config.ts"), "utf8"), expected);
    assert.deepEqual(
      [...await readdir(cwd)].sort(),
      [".gitignore", "readyrun.config.ts"],
    );
    await assert.doesNotReject(() => loadStub(cwd));
  });
}

test("init writes a GitHub and Cursor readyrun.config.ts at the Consumer root", async () => {
  await assertWrittenStub(githubCursorAnswers, githubCursorStub);
});

test("init writes a Linear and Claude readyrun.config.ts at the Consumer root", async () => {
  await assertWrittenStub(linearClaudeAnswers, linearClaudeStub);
});

test("init writes a custom Worker Adapter into the stub", async () => {
  await assertWrittenStub(githubCustomAnswers, githubCustomStub);
});

test("init writes a Linear state Frontier selector into the stub", async () => {
  await assertWrittenStub(linearStateAnswers, linearStateStub);
});

test("parseListedModels reads id and label from agent --list-models output", () => {
  assert.deepEqual(
    parseListedModels(`Available models
auto - Auto
composer-2.5 - Composer 2.5 (default)
composer-2 - Composer 2
`),
    [
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5", hint: "default" },
      { id: "composer-2", label: "Composer 2" },
    ],
  );
});

test("parseListedModels strips ANSI color and current markers", () => {
  assert.deepEqual(
    parseListedModels(
      "\u001b[36mauto\u001b[39m \u001b[2m- Auto (current)\u001b[22m\n",
    ),
    [{ id: "auto", label: "Auto", hint: "current" }],
  );
});

test("init creates a .gitignore that ignores .readyrun/ when none exists", async () => {
  await withConsumerRoot(async (cwd) => {
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(cwd, ".gitignore"), "utf8"), ".readyrun/\n");
  });
});

test("init appends .readyrun/ to an existing .gitignore that lacks it", async () => {
  await withConsumerRoot(async (cwd) => {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "node_modules/\n.readyrun/\n",
    );
  });
});

test("the Init outro links the written stub", () => {
  assert.equal(
    configWrittenMessage("/tmp/readyrun.config.ts"),
    "Wrote \u001b]8;;file:///tmp/readyrun.config.ts\u001b\\readyrun.config.ts\u001b]8;;\u001b\\",
  );
});
