import { defineConfig, github, opencode } from "@readyrun/readyrun";

export default defineConfig({
  tracker: github({
    repo: "MichaelBuss/readyrun",
    ready: "unblocked",
    labels: ["ready-for-agent"],
  }),
  worker: opencode(),
  model: "zai-coding-plan/glm-5.3-flash",
  permissions: "unattended",
  effort: "high",
  contextFile: "CONTEXT.md",
});
