/**
 * The SDK's one error type. An error means an operation could not run (a
 * refusal, such as a plan that blocks, is a result instead). Consumers branch
 * on its fields, never on a class: `code` names the condition, `kind` says what
 * a consumer can do about it without knowing every code, and `effect` says
 * whether the failure may have left something behind. Every code is declared
 * once in {@link ERROR_CODES} with its kind. An error serializes to plain data
 * with the same fields ({@link ZipKitErrorData}), and {@link isZipKitError}
 * recognizes that shape, so a failure received from another process is handled
 * like one thrown here. The message is for diagnostics; consumers present a
 * code through their own copy.
 */

/** What a consumer can do about a failure:
 *  - `invalid`: the call or its inputs are wrong (a malformed spec, a damaged
 *    archive); fix them, do not retry;
 *  - `unavailable`: the world did not cooperate (a missing or unreadable file,
 *    permissions, a disconnected drive); it may succeed later;
 *  - `cancelled`: the caller's signal stopped it, never a failure;
 *  - `internal`: the SDK broke its own invariant; report it. */
export type ErrorKind = "invalid" | "unavailable" | "cancelled" | "internal";

/** What the failure left in the world: `none` when nothing was changed, or
 *  `unknown` when a write may have taken effect (an archive published but not
 *  confirmed on disk, a publication still in flight, a temporary file left
 *  behind). */
export type ErrorEffect = "none" | "unknown";

/** Every error code with its kind. */
export const ERROR_CODES = {
  "spec.invalid": "invalid",
  "policy.invalid": "invalid",
  "options.invalid": "invalid",
  "request.invalid": "invalid",
  "output.ambiguous": "invalid",
  "input.prefix-collision": "invalid",
  "plan.invalid": "invalid",
  "path.not-absolute": "invalid",
  "path.missing": "unavailable",
  "path.denied": "unavailable",
  "io.failed": "unavailable",
  "scan.output-is-input": "invalid",
  "write.not-writable": "invalid",
  "write.source-changed": "unavailable",
  "archive.changed": "unavailable",
  "archive.not-zip": "invalid",
  "archive.malformed": "invalid",
  "archive.unsupported-method": "invalid",
  "archive.corrupt-data": "invalid",
  "archive.size-mismatch": "invalid",
  "manifest.missing": "invalid",
  "manifest.invalid": "invalid",
  "manifest.newer": "invalid",
  "operation.cancelled": "cancelled",
  "internal.unexpected": "internal",
} as const satisfies Record<string, ErrorKind>;

/** A condition the SDK can fail with. */
export type ErrorCode = keyof typeof ERROR_CODES;

/** The fields a code carries beyond the common ones; no code carries any yet. */
export interface ErrorDetails {}

/** Diagnostic fields carried as plain data; arbitrary custom payloads are excluded. */
export interface ErrorDiagnostic {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
  path?: string;
  cause?: ErrorDiagnostic;
}

/** Preserve the originating error chain without retaining objects or cycles. */
export function errorDiagnostic(value: unknown, seen = new Set<object>()): ErrorDiagnostic {
  if (typeof value !== "object" || value === null) return { name: "Error", message: String(value) };
  if (seen.has(value)) return { name: "Error", message: "[circular cause]" };
  seen.add(value);
  const e = value as Record<string, unknown>;
  const data: ErrorDiagnostic = { name: typeof e.name === "string" ? e.name : "Error", message: typeof e.message === "string" ? e.message : String(value) };
  for (const key of ["stack", "code", "syscall", "path"] as const) if (typeof e[key] === "string") data[key] = e[key];
  if (typeof e.errno === "string" || typeof e.errno === "number") data.errno = e.errno;
  if (e.cause !== undefined) data.cause = errorDiagnostic(e.cause, seen);
  return data;
}

/** A failure as plain data, including its originating diagnostic chain. */
export interface ZipKitErrorData {
  name: "ZipKitError";
  code: ErrorCode;
  kind: ErrorKind;
  effect: ErrorEffect;
  message: string;
  /** The path or entry the failure concerns, when there is one. */
  subject?: string;
  stack?: string;
  cause?: ErrorDiagnostic;
  details?: ErrorDetails[keyof ErrorDetails];
}

export interface ZipKitErrorOptions<C extends ErrorCode> {
  effect?: ErrorEffect;
  subject?: string;
  details?: C extends keyof ErrorDetails ? ErrorDetails[C] : never;
  cause?: unknown;
}

export class ZipKitError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "ZipKitError";
  readonly code: C;
  readonly kind: ErrorKind;
  readonly effect: ErrorEffect;
  readonly subject: string | undefined;
  readonly details: (C extends keyof ErrorDetails ? ErrorDetails[C] : never) | undefined;

  constructor(code: C, message: string, options: ZipKitErrorOptions<C> = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.kind = ERROR_CODES[code];
    this.effect = options.effect ?? "none";
    this.subject = options.subject;
    this.details = options.details;
  }

  toJSON(): ZipKitErrorData {
    const data: ZipKitErrorData = { name: "ZipKitError", code: this.code, kind: this.kind, effect: this.effect, message: this.message };
    if (this.stack !== undefined) data.stack = this.stack;
    if (this.cause !== undefined) data.cause = errorDiagnostic(this.cause);
    if (this.subject !== undefined) data.subject = this.subject;
    if (this.details !== undefined) data.details = this.details;
    return data;
  }
}

/** Whether `value` is a ZipKit failure: an error thrown here, or its plain
 *  data received from elsewhere. Judged by shape, so it holds across process
 *  and realm boundaries where `instanceof` does not. */
export function isZipKitError(value: unknown): value is ZipKitErrorData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && Object.hasOwn(ERROR_CODES, v.code) &&
    v.kind === ERROR_CODES[v.code as ErrorCode] &&
    (v.effect === "none" || v.effect === "unknown") &&
    typeof v.message === "string";
}

/** `err` as a failure that may have left something behind: once an operation
 *  has written part of its output, whatever stopped it leaves the effect
 *  unknown. A value that is not a ZipKit error is returned as it is. */
export function withUnknownEffect(err: unknown): unknown {
  if (!(err instanceof ZipKitError) || err.effect === "unknown") return err;
  const options: ZipKitErrorOptions<ErrorCode> = { effect: "unknown", cause: err.cause };
  if (err.subject !== undefined) options.subject = err.subject;
  if (err.details !== undefined) options.details = err.details as never;
  const updated = new ZipKitError(err.code, err.message, options);
  updated.stack = err.stack;
  return updated;
}

/** `err` naming `subject` when it names nothing yet, such as an archive fault
 *  found deep in a read that does not know which file it reads. A value that
 *  is not a ZipKit error, or one that has a subject, is returned as it is. */
export function withSubject(err: unknown, subject: string): unknown {
  if (!(err instanceof ZipKitError) || err.subject !== undefined) return err;
  const options: ZipKitErrorOptions<ErrorCode> = { effect: err.effect, cause: err.cause, subject };
  if (err.details !== undefined) options.details = err.details as never;
  const updated = new ZipKitError(err.code, err.message, options);
  updated.stack = err.stack;
  return updated;
}

/** A file-system failure at `subject` as a ZipKit error, by what the system
 *  reported: the path is missing, access was denied, or the operation failed
 *  otherwise. A ZipKit error is returned as it is. */
export function fsFailure(err: unknown, subject: string): ZipKitError {
  if (err instanceof ZipKitError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT" || code === "ENOTDIR") return new ZipKitError("path.missing", message, { cause: err, subject });
  if (code === "EACCES" || code === "EPERM") return new ZipKitError("path.denied", message, { cause: err, subject });
  return new ZipKitError("io.failed", message, { cause: err, subject });
}

/** Whatever `err` is, as a ZipKit error: itself when it is one, a file-system
 *  failure at `subject` when the system reported one (it carries an errno
 *  `code`), and otherwise a fault in the SDK itself. */
export function classify(err: unknown, subject: string): ZipKitError {
  if (err instanceof ZipKitError) return err;
  if (typeof (err as { code?: unknown } | null)?.code === "string") return fsFailure(err, subject);
  return new ZipKitError("internal.unexpected", err instanceof Error ? err.message : String(err), { cause: err, subject });
}

/** The cancellation error for a signal's reason. */
export function toAbortError(err: unknown, fallback = "operation cancelled", effect: ErrorEffect = "none"): ZipKitError<"operation.cancelled"> {
  if (err instanceof ZipKitError && err.code === "operation.cancelled") return err as ZipKitError<"operation.cancelled">;
  if (err instanceof Error) return new ZipKitError("operation.cancelled", err.message || fallback, { cause: err, effect });
  return new ZipKitError("operation.cancelled", typeof err === "string" && err.length > 0 ? err : fallback, { effect });
}

/** Throw the cancellation error if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}
