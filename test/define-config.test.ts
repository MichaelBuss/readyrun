import assert from "node:assert/strict";
import { test } from "node:test";
import { claude, cursor, custom, defineConfig, github, linear, UnknownConfigKeyError } from "../src/mod.ts";

test("a Consumer can assemble defineConfig with typed Tracker Adapter and Worker Adapter factories", () => {
  const githubConfig = defineConfig({
    tracker: github({
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: cursor(),
    model: "composer-2",
  });
  assert.equal(githubConfig.model, "composer-2");

  const linearConfig = defineConfig({
    tracker: linear({
      ready: "unblocked",
      label: "ready-for-agent",
    }),
    worker: claude(),
    model: "opus",
  });
  assert.equal(linearConfig.model, "opus");

  const customConfig = defineConfig({
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
  assert.equal(customConfig.model, "local-model");
});

test("Permissions default to ask", () => {
  const config = defineConfig({
    tracker: github({
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: cursor(),
    model: "composer-2",
  });
  assert.equal(config.permissions, "ask");
});

test("a custom Worker Adapter is told which unattended flag to use", () => {
  const worker = custom({
    bin: "my-agent",
    unattendedFlag: "--dangerously-skip-permissions",
  });
  assert.equal(worker.options.unattendedFlag, "--dangerously-skip-permissions");
});

test("unknown config keys are an error, not ignored", () => {
  const config = {
    tracker: github({
      repo: "acme/widgets",
      ready: "unblocked",
      labels: ["ready-for-agent"],
    }),
    worker: cursor(),
    model: "composer-2",
    unknownKnob: true,
  };

  assert.throws(
    () => defineConfig(config),
    (error: unknown) => {
      assert.ok(error instanceof UnknownConfigKeyError);
      assert.deepEqual([...error.keys], ["unknownKnob"]);
      return true;
    },
  );
});

test("unknown keys on a Tracker Adapter factory are an error", () => {
  const options = {
    repo: "acme/widgets",
    ready: "unblocked" as const,
    labels: ["ready-for-agent"],
    owner: "acme",
  };

  assert.throws(
    () => github(options),
    (error: unknown) => {
      assert.ok(error instanceof UnknownConfigKeyError);
      assert.deepEqual([...error.keys], ["owner"]);
      return true;
    },
  );
});
