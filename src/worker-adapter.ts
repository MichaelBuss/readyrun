const brand = Symbol("WorkerAdapter");

export type WorkerAdapter = {
  readonly [brand]: true;
};

export function createWorkerAdapter(): WorkerAdapter {
  return { [brand]: true };
}
