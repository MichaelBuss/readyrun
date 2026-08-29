import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cli, loadConfig } from "../src/cli.ts";
import { defineConfig, type DoctorOptions, type InitOptions, type RunOptions } from "../src/mod.ts";
import { memoryTracker, recordingWorker } from "../src/testing/mod.ts";

const silent = { write(_chunk?: string) { return true; } };

const config = defineConfig({
  tracker: memoryTracker({
    tickets: [],
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: recordingWorker(),
  model: "composer-2",
});

const tmpRoot = join(fileURLToPath(new URL(".", import.meta.url)), ".tmp");
const packageHref = pathToFileURL(
  join(fileURLToPath(new URL(".", import.meta.url)), "../src/mod.ts"),
).href;

function consumerConfigSource(): string {
  return `import { defineConfig, github, cursor } from ${JSON.stringify(packageHref)};

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
}

async function withConsumerRoot(
  setup: (cwd: string) => Promise<void>,
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const cwd = await mkdtemp(join(tmpRoot, "consumer-"));
  try {
    await setup(cwd);
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("bare readyrun prints usage rather than opening a menu", async () => {
  const chunks: string[] = [];
  const exitCode = await cli({
    argv: [],
    stdout: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  });
  const output = chunks.join("");
  assert.match(output, /Usage: readyrun/);
  assert.match(output, /init/);
  assert.match(output, /run --max/);
  assert.match(output, /doctor/);
  assert.doesNotMatch(output, /menu|wizard|select/i);
  assert.equal(exitCode, 1);
});

test("readyrun run --max N hands the same options object the programmatic entry takes", async () => {
  const received: RunOptions[] = [];
  const exitCode = await cli({
    argv: ["run", "--max", "5"],
    cwd: "/consumer",
    stdout: silent,
    loadConfig: async () => config,
    run: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.cap, 5);
  assert.equal(received[0]?.config, config);
  assert.equal(received[0]?.cwd, "/consumer");
  assert.equal(received[0]?.permissions, undefined);
});

test("a Run without a cap is refused at the CLI", async () => {
  const chunks: string[] = [];
  const exitCode = await cli({
    argv: ["run"],
    stdout: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    loadConfig: async () => config,
  });
  assert.equal(exitCode, 1);
  assert.match(chunks.join(""), /A Run cannot start without a cap/);
});

test("readyrun run uses a cap supplied in config when --max is omitted", async () => {
  const received: RunOptions[] = [];
  const withCap = defineConfig({ ...config, cap: 3 });
  const exitCode = await cli({
    argv: ["run"],
    stdout: silent,
    loadConfig: async () => withCap,
    run: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(received[0]?.cap, undefined);
  assert.equal(received[0]?.config.cap, 3);
});

test("permissions default to ask unless the operator passes unattended", async () => {
  const received: RunOptions[] = [];
  await cli({
    argv: ["run", "--max", "1"],
    stdout: silent,
    loadConfig: async () => config,
    run: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(received[0]?.permissions, undefined);
  await cli({
    argv: ["run", "--max", "1", "--permissions", "unattended"],
    stdout: silent,
    loadConfig: async () => config,
    run: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(received[1]?.permissions, "unattended");
});

test("--model overrides the config default for this Run", async () => {
  const received: RunOptions[] = [];
  await cli({
    argv: ["run", "--max", "1", "--model", "opus"],
    stdout: silent,
    loadConfig: async () => config,
    run: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(received[0]?.model, "opus");
});

test("readyrun doctor runs the shared check with the loaded config", async () => {
  const received: DoctorOptions[] = [];
  const exitCode = await cli({
    argv: ["doctor"],
    cwd: "/consumer",
    stdout: silent,
    loadConfig: async () => config,
    doctor: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.config, config);
  assert.equal(received[0]?.cwd, "/consumer");
});

test("doctor refuses when there is no config file at the Consumer root", async () => {
  await withConsumerRoot(
    async () => {},
    async (cwd) => {
      const chunks: string[] = [];
      let checked = false;
      const exitCode = await cli({
        argv: ["doctor"],
        cwd,
        stdout: {
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        },
        doctor: async () => {
          checked = true;
          return 0;
        },
      });
      assert.equal(exitCode, 1);
      assert.equal(checked, false);
      assert.match(chunks.join(""), /readyrun\.config/);
    },
  );
});

test("ReadyRun loads one config file at the Consumer root, same basename, TypeScript / JS / MJS", async () => {
  for (const name of ["readyrun.config.ts", "readyrun.config.js", "readyrun.config.mjs"]) {
    await withConsumerRoot(
      async (cwd) => {
        await writeFile(
          join(cwd, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        await writeFile(join(cwd, name), consumerConfigSource());
      },
      async (cwd) => {
        const loaded = await loadConfig(cwd);
        assert.equal(loaded.model, "composer-2");
      },
    );
  }
});

test("ReadyRun does not search other config filenames", async () => {
  await withConsumerRoot(
    async (cwd) => {
      await writeFile(join(cwd, ".readyrunrc.ts"), consumerConfigSource());
      await writeFile(join(cwd, "readyrun.config.json"), "{}\n");
      await writeFile(join(cwd, "readyrun.config.cjs"), consumerConfigSource());
    },
    async (cwd) => {
      await assert.rejects(
        () => loadConfig(cwd),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /readyrun\.config\.(ts|js|mjs)/);
          return true;
        },
      );
    },
  );
});

test("multiple config files of the same basename are refused", async () => {
  await withConsumerRoot(
    async (cwd) => {
      await writeFile(join(cwd, "readyrun.config.ts"), consumerConfigSource());
      await writeFile(join(cwd, "readyrun.config.mjs"), consumerConfigSource());
    },
    async (cwd) => {
      await assert.rejects(
        () => loadConfig(cwd),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Multiple config files/);
          return true;
        },
      );
    },
  );
});

test("invoking the readyrun binary with no arguments prints usage", async () => {
  const bin = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [bin], {
    encoding: "utf8",
  }).then(
    (ok) => ({ stdout: ok.stdout, status: 0 }),
    (error: { stdout?: string; code?: number }) => ({
      stdout: error.stdout ?? "",
      status: error.code ?? 1,
    }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: readyrun/);
});

const initAnswers = {
  tracker: {
    kind: "github" as const,
    repo: "acme/widgets",
    labels: ["ready-for-agent"],
  },
  worker: { kind: "cursor" as const },
  model: "composer-2",
};

test("readyrun init hands answers to the same writer the tests call", async () => {
  const received: InitOptions[] = [];
  const exitCode = await cli({
    argv: ["init"],
    cwd: "/consumer",
    stdout: silent,
    answers: initAnswers,
    init: async (options) => {
      received.push(options);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.cwd, "/consumer");
  assert.equal(received[0]?.answers, initAnswers);
});

test("init does not assemble a run command", async () => {
  let ran = false;
  const exitCode = await cli({
    argv: ["init"],
    cwd: "/consumer",
    stdout: silent,
    answers: initAnswers,
    run: async () => {
      ran = true;
      return 0;
    },
    init: async () => 0,
  });
  assert.equal(exitCode, 0);
  assert.equal(ran, false);
});

test("init writes the stub without loading a config file", async () => {
  await withConsumerRoot(
    async () => {},
    async (cwd) => {
      let loaded = false;
      const exitCode = await cli({
        argv: ["init"],
        cwd,
        stdout: silent,
        answers: initAnswers,
        loadConfig: async () => {
          loaded = true;
          return config;
        },
      });
      assert.equal(exitCode, 0);
      assert.equal(loaded, false);
      assert.deepEqual(await readdir(cwd), ["readyrun.config.ts"]);
    },
  );
});
