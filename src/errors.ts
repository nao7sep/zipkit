/**
 * The ZipKit error hierarchy. A single abstract base carries a discriminating
 * `errorType` and a stable, dot-separated `code`; concrete subclasses fix the
 * type. This is the committed error surface: consumers can branch on
 * `errorType` without importing the concrete classes.
 */

export type ZipKitErrorType = "scan" | "policy" | "write" | "read" | "abort";

export abstract class ZipKitError extends Error {
  abstract readonly errorType: ZipKitErrorType;
  readonly code: string;
  /**
   * Whether this fault is the caller's to fix — a malformed invocation or input
   * — as opposed to a runtime failure the world handed us. This is orthogonal to
   * `errorType`, which says *where* it failed: a scan or a read can fail for
   * either reason, so the attribution lives on its own axis rather than being
   * inferred from the domain or the code string. It drives the usage exit code
   * (2) and the CLI's report-vs-rethrow split.
   */
  readonly usage: boolean;

  constructor(code: string, message: string, options?: { cause?: unknown; usage?: boolean }) {
    super(message, options);
    this.code = code;
    this.name = this.constructor.name;
    this.usage = options?.usage ?? false;
  }
}

/** A filesystem read failed while scanning the source tree. */
export class ScanError extends ZipKitError {
  readonly errorType = "scan" as const;
}

/** The spec or policy is invalid or under-specified (a configuration fault).
 *  Always a usage fault — the caller controls the spec, policy, and options. */
export class PolicyError extends ZipKitError {
  readonly errorType = "policy" as const;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, { ...options, usage: true });
  }
}

/** Writing the archive failed, or the plan was not writable. */
export class WriteError extends ZipKitError {
  readonly errorType = "write" as const;
}

/**
 * Reading or extracting an archive failed: the file is not a well-formed ZIP, an
 * entry uses an unsupported method, a requested manifest is absent, or a target
 * file could not be written during extraction.
 */
export class ReadError extends ZipKitError {
  readonly errorType = "read" as const;
}

/** The operation was cancelled through an `AbortSignal`. */
export class AbortError extends ZipKitError {
  readonly errorType = "abort" as const;

  constructor(message = "operation aborted", options?: { cause?: unknown }) {
    super("aborted", message, options);
    this.name = "AbortError";
  }
}

/**
 * Whether a thrown value is a *usage* fault — the caller's invocation was
 * malformed: an invalid spec/policy, a named input/archive that cannot be
 * opened, or a missing destination. These occur before a verb produces any
 * report, so they carry an exit-2 (usage) code and a CLI verb action re-throws
 * them to the run layer rather than folding them into a report; operational
 * faults that arise mid-run are folded instead. The attribution rides on each
 * error's {@link ZipKitError.usage} flag — set at the throw site, not inferred
 * from a code-string allowlist — so this is a single, drift-free predicate.
 */
export function isUsageFault(err: unknown): boolean {
  return err instanceof ZipKitError && err.usage;
}

/**
 * The single exit-code classifier, shared by the CLI's top-level mapping and by
 * each verb's operational-fault fold so the two can never disagree. The category
 * is *whose fault*, then *which domain*:
 *
 * - cancellation → `130`;
 * - usage faults (a malformed invocation — see {@link isUsageFault}) → `2`;
 * - runtime faults map to a distinct code per domain — `scan` → `3`,
 *   `write` → `4`, `read` → `5` — so a caller can branch on which side of the
 *   pipeline failed;
 * - anything else → `1`.
 *
 * Exit `1` is reserved by the CLI for a *negative domain verdict* (a non-writable
 * plan, an extract whose `reportOk` is false): the verb ran cleanly but its
 * result is "no." That is set directly by the verb, not routed through here —
 * this function classifies *thrown* faults only.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof ZipKitError && err.errorType === "abort") return 130;
  if (isUsageFault(err)) return 2;
  if (err instanceof ZipKitError) {
    switch (err.errorType) {
      case "scan":
        return 3;
      case "write":
        return 4;
      case "read":
        return 5;
    }
  }
  return 1;
}

/** Coerce an arbitrary thrown value into an {@link AbortError}. */
export function toAbortError(err: unknown, fallback = "operation aborted"): AbortError {
  if (err instanceof AbortError) return err;
  if (err instanceof Error) {
    return new AbortError(err.message || fallback, { cause: err });
  }
  return new AbortError(typeof err === "string" && err.length > 0 ? err : fallback);
}

/** Throw an {@link AbortError} if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}
