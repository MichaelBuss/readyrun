import { githubFromWorld } from "./github-http-fixture.ts";
import { trackerAdapterContract } from "./tracker-adapter-contract.ts";

trackerAdapterContract("GitHub Tracker Adapter", (world) => {
  return githubFromWorld(world).adapter;
});
