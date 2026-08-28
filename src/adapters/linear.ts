import {
  createTrackerAdapter,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownLinearKeys = new Set([
  "ready",
  "state",
  "label",
  "project",
  "parent",
  "ids",
]);

export type LinearTrackerOptions = {
  ready: "unblocked";
  state?: string;
  label?: string;
  project?: string;
  parent?: string;
  ids?: string[];
};

export function linear(options: LinearTrackerOptions): TrackerAdapter {
  assertKnownKeys(options, knownLinearKeys);
  return Object.assign(createTrackerAdapter(), { options });
}
