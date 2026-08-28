import { defineConfig, type ReadyRunConfig } from "./config.ts";

export type RunOptions = {
  config: ReadyRunConfig;
  cap?: number;
};

export class RunCapRequiredError extends Error {
  constructor() {
    super("A Run cannot start without a cap");
    this.name = "RunCapRequiredError";
  }
}

export async function run(options: RunOptions): Promise<void> {
  const config = defineConfig(options.config);
  const cap = options.cap ?? config.cap;
  if (cap === undefined) {
    throw new RunCapRequiredError();
  }
}
