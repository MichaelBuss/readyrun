import {
  createTrackerAdapter,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownGitHubKeys = new Set([
  "repo",
  "ready",
  "labels",
  "parent",
  "ids",
]);

export type GitHubTrackerOptions = {
  repo: string;
  ready: "unblocked";
  labels: string[];
  parent?: string;
  ids?: string[];
};

export function github(options: GitHubTrackerOptions): TrackerAdapter {
  assertKnownKeys(options, knownGitHubKeys);
  return Object.assign(createTrackerAdapter(), { options });
}
