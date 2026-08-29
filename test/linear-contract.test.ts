import { linearFromWorld } from "./linear-http-fixture.ts";
import { trackerAdapterContract } from "./tracker-adapter-contract.ts";

trackerAdapterContract("Linear Tracker Adapter", (world) => {
  return linearFromWorld(world).adapter;
});
