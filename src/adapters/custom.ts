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

/**
 * What {@link custom} takes: the binary to wrap and how to drive it. With no
 * `effortVocabulary` option the Adapter declares none — the empty vocabulary
 * — so a config effort on it is a compile error, matching the runtime Doctor
 * lie a flag-without-declaration is (ADR 0042).
 */
export type CustomWorkerOptions<
  // The default matches custom(): with no effortVocabulary option the
  // Adapter declares none.
  Vocabulary extends readonly Effort[] = readonly [],
> = {
  /** The binary spawned once per Ticket. */
  bin: string;
  /** The argv between the binary and `--model`; `{cwd}` interpolates to the Worktree. */
  args?: string[];
  /** The flag passed when Permissions are `"unattended"`. */
  unattendedFlag: string;
  /**
   * The flag that passes Effort. The wrapped binary maps no Effort until
   * custom() declares both the flag it takes and the vocabulary it can
   * honestly pass (ADR 0042): passing --effort through blind implied the
   * standard five for whatever binary the Consumer wrapped. A flag without a
   * declaration is a Doctor config lie.
   */
  effortFlag?: string;
  /** The Effort values the wrapped binary can honestly receive. */
  effortVocabulary?: Vocabulary;
};

/** A {@link custom} Adapter, carrying the options it was built from. */
export type CustomWorkerAdapter<
  Vocabulary extends readonly Effort[] = readonly Effort[],
> = WorkerAdapter<Vocabulary> & {
  /** The options the Adapter was built with. */
  readonly options: CustomWorkerOptions<Vocabulary>;
};

/**
 * The Worker Adapter for any coding CLI: you name the binary, its static
 * argv, and its unattended flag; ReadyRun appends `--model <model>`, the
 * declared effort flag when Effort is in play, the unattended flag when
 * Permissions are `"unattended"`, and the prompt. With no
 * `effortVocabulary` option the Adapter declares the empty vocabulary, so a
 * config effort on it is a compile error (ADR 0042).
 */
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
