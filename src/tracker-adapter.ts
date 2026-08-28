const brand = Symbol("TrackerAdapter");

export type TrackerAdapter = {
  readonly [brand]: true;
};

export function createTrackerAdapter(): TrackerAdapter {
  return { [brand]: true };
}
