import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  configWrittenMessage,
  init,
  listOpencodeModels,
  parseBareModelIds,
  parseInitAnswers,
  parseListedModels,
  type InitAnswers,
} from "../src/init.ts";
import { readReceipt, withRecordingPath } from "./stub-worker.ts";

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
  permissions: "unattended",
});
`;

const githubCursorContextStub = `import { defineConfig, github, cursor } from "@readyrun/readyrun";

export default defineConfig({
  tracker: github({
    repo: "acme/widgets",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: cursor(),
  model: "composer-2",
  permissions: "unattended",
  contextFile: "CONTEXT.md",
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
  permissions: "unattended",
  effort: "high",
});
`;

const githubOpencodeAnswers: InitAnswers = {
  tracker: {
    kind: "github",
    repo: "acme/widgets",
    labels: ["ready-for-agent"],
  },
  worker: { kind: "opencode" },
  model: "zai-coding-plan/glm-5.3-flash",
  effort: "high",
};

const githubOpencodeStub = `import { defineConfig, github, opencode } from "@readyrun/readyrun";

export default defineConfig({
  tracker: github({
    repo: "acme/widgets",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: opencode(),
  model: "zai-coding-plan/glm-5.3-flash",
  permissions: "unattended",
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
  permissions: "unattended",
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
  permissions: "unattended",
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

test("init writes a GitHub and OpenCode readyrun.config.ts at the Consumer root", async () => {
  await assertWrittenStub(githubOpencodeAnswers, githubOpencodeStub);
});

test("init writes a custom Worker Adapter into the stub", async () => {
  await assertWrittenStub(githubCustomAnswers, githubCustomStub);
});

test("init writes a Linear state Frontier selector into the stub", async () => {
  await assertWrittenStub(linearStateAnswers, linearStateStub);
});

test("init points contextFile at a CONTEXT.md already at the Consumer root", async () => {
  await withConsumerRoot(async (cwd) => {
    await writeFile(join(cwd, "CONTEXT.md"), "# Language\n");
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(cwd, "readyrun.config.ts"), "utf8"),
      githubCursorContextStub,
    );
    await assert.doesNotReject(() => loadStub(cwd));
  });
});

test("init omits contextFile when the Consumer root has no CONTEXT.md", async () => {
  await assertWrittenStub(githubCursorAnswers, githubCursorStub);
});

test("parseInitAnswers accepts an effort answer only for the Adapter that declares it", () => {
  const base = {
    tracker: { kind: "github", repo: "acme/widgets", labels: ["ready-for-agent"] },
    model: "opus",
  };
  const claude = parseInitAnswers({
    ...base,
    worker: { kind: "claude" },
    effort: "high",
  });
  assert.equal(claude.ok, true);
  assert.equal(claude.ok && claude.answers.effort, "high");

  const cursor = parseInitAnswers({
    ...base,
    worker: { kind: "cursor" },
    effort: "high",
  });
  assert.equal(cursor.ok, false);
  assert.match(
    cursor.ok ? "" : cursor.message,
    /the cursor Worker Adapter does not map it/,
  );

  const custom = parseInitAnswers({
    ...base,
    worker: { kind: "custom", bin: "my-agent", unattendedFlag: "--go" },
    effort: "high",
  });
  assert.equal(custom.ok, false);
  assert.match(
    custom.ok ? "" : custom.message,
    /the custom Worker Adapter does not map it/,
  );

  const opencode = parseInitAnswers({
    ...base,
    worker: { kind: "opencode" },
    effort: "high",
  });
  assert.equal(opencode.ok, true);
  assert.equal(opencode.ok && opencode.answers.effort, "high");

  const opencodeLow = parseInitAnswers({
    ...base,
    worker: { kind: "opencode" },
    effort: "low",
  });
  assert.equal(opencodeLow.ok, false);
  assert.match(
    opencodeLow.ok ? "" : opencodeLow.message,
    /the opencode Worker Adapter does not map it/,
  );

  const opencodeNoEffort = parseInitAnswers({
    ...base,
    worker: { kind: "opencode" },
  });
  assert.equal(opencodeNoEffort.ok, true);

  const unknownKind = parseInitAnswers({
    ...base,
    worker: { kind: "codex" },
  });
  assert.equal(unknownKind.ok, false);
  assert.match(
    unknownKind.ok ? "" : unknownKind.message,
    /Worker must be cursor, claude, opencode, or custom/,
  );

  const malformed = parseInitAnswers({
    ...base,
    worker: { kind: "claude" },
    effort: "yolo",
  });
  assert.equal(malformed.ok, false);
  assert.match(
    malformed.ok ? "" : malformed.message,
    /Effort must be low, medium, high, xhigh, or max/,
  );
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

test("parseBareModelIds reads one bare provider/model id per line from opencode models output", () => {
  assert.deepEqual(
    parseBareModelIds(`opencode/grok-code
zai-coding-plan/glm-5.3-flash
zai-coding-plan/glm-4.6
`),
    [
      { id: "opencode/grok-code", label: "opencode/grok-code" },
      {
        id: "zai-coding-plan/glm-5.3-flash",
        label: "zai-coding-plan/glm-5.3-flash",
      },
      { id: "zai-coding-plan/glm-4.6", label: "zai-coding-plan/glm-4.6" },
    ],
  );
});

test("parseBareModelIds strips ANSI color, trims, and dedupes bare ids", () => {
  assert.deepEqual(
    parseBareModelIds(
      "\u001b[36mopencode/grok-code\u001b[39m\n  opencode/grok-code  \n\n",
    ),
    [{ id: "opencode/grok-code", label: "opencode/grok-code" }],
  );
});

test("listOpencodeModels falls back to an empty list when opencode is missing", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "/no/such/readyrun-path";
  try {
    assert.deepEqual(await listOpencodeModels(), []);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("listOpencodeModels falls back to an empty list when opencode models prints zero lines", async () => {
  const previousStdout = process.env.READYRUN_STUB_STDOUT;
  process.env.READYRUN_STUB_STDOUT = "";
  try {
    await withRecordingPath(["opencode"], async () => {
      assert.deepEqual(await listOpencodeModels(), []);
    });
  } finally {
    if (previousStdout === undefined) {
      delete process.env.READYRUN_STUB_STDOUT;
    } else {
      process.env.READYRUN_STUB_STDOUT = previousStdout;
    }
  }
});

test("listOpencodeModels offers the ids a stubbed opencode models prints", async () => {
  const previousStdout = process.env.READYRUN_STUB_STDOUT;
  process.env.READYRUN_STUB_STDOUT = `opencode/grok-code
zai-coding-plan/glm-5.3-flash
`;
  try {
    await withRecordingPath(["opencode"], async ({ receiptPath }) => {
      assert.deepEqual(await listOpencodeModels(), [
        { id: "opencode/grok-code", label: "opencode/grok-code" },
        {
          id: "zai-coding-plan/glm-5.3-flash",
          label: "zai-coding-plan/glm-5.3-flash",
        },
      ]);
      const receipt = await readReceipt(receiptPath);
      assert.deepEqual(receipt.argv, ["models"]);
    });
  } finally {
    if (previousStdout === undefined) {
      delete process.env.READYRUN_STUB_STDOUT;
    } else {
      process.env.READYRUN_STUB_STDOUT = previousStdout;
    }
  }
});

test("init writes a model picked from a stubbed opencode models list", async () => {
  const previousStdout = process.env.READYRUN_STUB_STDOUT;
  process.env.READYRUN_STUB_STDOUT = `opencode/grok-code
zai-coding-plan/glm-4.6
`;
  try {
    await withRecordingPath(["opencode"], async () => {
      const models = await listOpencodeModels();
      const picked = models[1]?.id;
      assert.ok(picked !== undefined);
      await assertWrittenStub(
        { ...githubOpencodeAnswers, model: picked },
        githubOpencodeStub.replace(
          `model: "zai-coding-plan/glm-5.3-flash"`,
          `model: "${picked}"`,
        ),
      );
    });
  } finally {
    if (previousStdout === undefined) {
      delete process.env.READYRUN_STUB_STDOUT;
    } else {
      process.env.READYRUN_STUB_STDOUT = previousStdout;
    }
  }
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

test("init does not duplicate .readyrun/ when the exact line is already present", async () => {
  await withConsumerRoot(async (cwd) => {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n.readyrun/\n");
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "node_modules/\n.readyrun/\n",
    );
  });
});

test("init does not duplicate .readyrun/ when a broader pattern already covers it", async () => {
  await withConsumerRoot(async (cwd) => {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n.ready*\n");
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(cwd, ".gitignore"), "utf8"),
      "node_modules/\n.ready*\n",
    );
  });
});

test("init does not duplicate .readyrun/ when the existing line is root-anchored or dir-only", async () => {
  await withConsumerRoot(async (cwd) => {
    await writeFile(join(cwd, ".gitignore"), "/.readyrun\n");
    const exitCode = await init({ cwd, answers: githubCursorAnswers });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(cwd, ".gitignore"), "utf8"), "/.readyrun\n");
  });
});

test("the Init outro links the written stub", () => {
  assert.equal(
    configWrittenMessage("/tmp/readyrun.config.ts"),
    "Wrote \u001b]8;;file:///tmp/readyrun.config.ts\u001b\\readyrun.config.ts\u001b]8;;\u001b\\",
  );
});
