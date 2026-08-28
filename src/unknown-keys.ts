export class UnknownConfigKeyError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Unknown config key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}`);
    this.name = "UnknownConfigKeyError";
    this.keys = keys;
  }
}

export function assertKnownKeys(
  value: object,
  known: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new UnknownConfigKeyError(unknown);
  }
}
