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

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = this.constructor.name;
  }
}

/** A filesystem read failed while scanning the source tree. */
export class ScanError extends ZipKitError {
  readonly errorType = "scan" as const;
}

/** The spec or policy is invalid or under-specified (a configuration fault):
 *  the caller controls the spec, policy, and options. */
export class PolicyError extends ZipKitError {
  readonly errorType = "policy" as const;
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
