import { memoryTracker } from "../src/testing/mod.ts";
import { trackerAdapterContract } from "./tracker-adapter-contract.ts";

trackerAdapterContract("memory Tracker Adapter", memoryTracker);
