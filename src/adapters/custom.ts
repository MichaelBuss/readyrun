import {
  assertKnownPlaceholders,
  assembledWorker,
  type Effort,
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
  /**
   * The argv between the binary and `--model`; `{cwd}` interpolates to the
   * Worktree. An unknown `{placeholder}` is refused here, at construction.
   */
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
 * argv, and its unattended flag; the shared argv grammar appends
 * `--model <model>`, the declared effort flag when Effort is in play, the
 * unattended flag when Permissions are `"unattended"`, and the prompt. The
 * declared args ride the same assembly the print-mode Adapters use — as the
 * leading args, with print mode suppressed, since the wrapped binary may
 * still be able to ask. With no `effortVocabulary` option the Adapter
 * declares the empty vocabulary, so a config effort on it is a compile error
 * (ADR 0042).
 */
export function custom<Vocabulary extends readonly Effort[] = readonly []>(
  options: CustomWorkerOptions<Vocabulary>,
): CustomWorkerAdapter<Vocabulary> {
  assertKnownKeys(options, knownCustomKeys);
  // The declared argv interpolates exactly one placeholder, `{cwd}`; the lie
  // is refused here, where the Consumer wrote it, not at Doctor or spawn.
  assertKnownPlaceholders("args", options.args ?? []);
  return Object.assign(
    assembledWorker(options.bin, options.unattendedFlag, {
      ...(options.effortFlag === undefined ? {} : { effortFlag: options.effortFlag }),
      ...(options.effortVocabulary === undefined
        ? {}
        : { effortVocabulary: options.effortVocabulary }),
      leadingArgs: options.args ?? [],
      printMode: false,
    }),
    { options },
  );
}
