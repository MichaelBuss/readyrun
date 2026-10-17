import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerAdapter,
  declaredEffortVocabulary,
  mapsEffort,
} from "../src/worker-adapter.ts";

test("mapsEffort answers true when the Worker Adapter maps a flag over a declared vocabulary", () => {
  assert.equal(
    mapsEffort(
      createWorkerAdapter({ effortFlag: "--effort", effortVocabulary: ["high"] }),
    ),
    true,
  );
});

test("mapsEffort answers false when the Worker Adapter names no flag, whatever it declares", () => {
  assert.equal(mapsEffort(createWorkerAdapter({ effortVocabulary: ["high"] })), false);
});

test("mapsEffort answers false when the Worker Adapter declares an empty vocabulary", () => {
  assert.equal(
    mapsEffort(createWorkerAdapter({ effortFlag: "--effort", effortVocabulary: [] })),
    false,
  );
});

test("mapsEffort answers false when the Worker Adapter declares neither flag nor vocabulary", () => {
  assert.equal(mapsEffort(createWorkerAdapter()), false);
});

test("declaredEffortVocabulary answers the values the Worker Adapter declares, in order", () => {
  assert.deepEqual(
    declaredEffortVocabulary(
      createWorkerAdapter({ effortFlag: "--variant", effortVocabulary: ["high", "max"] }),
    ),
    ["high", "max"],
  );
});

test("declaredEffortVocabulary answers empty for a Worker Adapter that declares none", () => {
  assert.deepEqual(declaredEffortVocabulary(createWorkerAdapter()), []);
});
