import {
  createWorkerAdapter,
  interpolateCwdArgs,
  spawnWorkerBinary,
  type Effort,
  type SpawnRequest,
  type WorkerAdapter,
} from "../worker-adapter.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownCustomKeys = new Set([
  "bin",
  "args",
  "unattendedFlag",
  "effortFlag",
  "effortVocabulary",
]);

export type CustomWorkerOptions<
  // The default matches custom(): with no effortVocabulary option the
  // Adapter declares none.
  Vocabulary extends readonly Effort[] = readonly [],
> = {
  bin: string;
  args?: string[];
  unattendedFlag: string;
  // The wrapped binary maps no Effort until custom() declares both the flag
  // it takes and the vocabulary it can honestly pass (ADR 0042): passing
  // --effort through blind implied the standard five for whatever binary the
  // Consumer wrapped. A flag without a declaration is a Doctor config lie.
  effortFlag?: string;
  effortVocabulary?: Vocabulary;
};

export type CustomWorkerAdapter<
  Vocabulary extends readonly Effort[] = readonly Effort[],
> = WorkerAdapter<Vocabulary> & {
  readonly options: CustomWorkerOptions<Vocabulary>;
};

// With no effortVocabulary option the Adapter declares none — the empty
// vocabulary — so a config effort on it is a compile error, matching the
// runtime Doctor lie a flag-without-declaration is (ADR 0042).
export function custom<Vocabulary extends readonly Effort[] = readonly []>(
  options: CustomWorkerOptions<Vocabulary>,
): CustomWorkerAdapter<Vocabulary> {
  assertKnownKeys(options, knownCustomKeys);
  return Object.assign(
    createWorkerAdapter({
      bin: options.bin,
      ...(options.effortFlag === undefined ? {} : { effortFlag: options.effortFlag }),
      ...(options.effortVocabulary === undefined
        ? {}
        : { effortVocabulary: options.effortVocabulary }),
      staticArgv:
        options.args === undefined ? undefined : { option: "args", args: options.args },
      spawn(request: SpawnRequest) {
        const args = [
          ...interpolateCwdArgs(options.args ?? [], request.cwd),
          "--model",
          request.model,
          ...(request.effort !== undefined && options.effortFlag !== undefined
            ? [options.effortFlag, request.effort]
            : []),
          ...(request.permissions === "unattended" ? [options.unattendedFlag] : []),
          request.prompt,
        ];
        return spawnWorkerBinary(options.bin, args, request.cwd, {
          capture: request.capture,
          timeoutMs: request.timeoutMs,
        });
      },
    }),
    { options },
  );
}
