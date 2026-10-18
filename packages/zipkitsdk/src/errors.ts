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
 *    permissions, a stalled volume); it may succeed later;
 *  - `cancelled`: the caller's signal stopped it, never a failure;
 *  - `internal`: the SDK broke its own invariant; report it. */
export type ErrorKind = "invalid" | "unavailable" | "cancelled" | "internal";

/** What the failure left in the world: `none` when nothing was changed, or
 *  `unknown` when a write may have taken effect (an archive published but not
 *  confirmed on disk, a publication still in flight, extracted files written
 *  before the failure). */
export type ErrorEffect = "none" | "unknown";

/** Every error code with its kind. */
export const ERROR_CODES = {
  "spec.invalid": "invalid",
  "policy.invalid": "invalid",
  "options.invalid": "invalid",
  "output.ambiguous": "invalid",
  "input.prefix-collision": "invalid",
  "plan.not-exportable": "invalid",
  "plan.transfer-invalid": "invalid",
  "scan.input-missing": "unavailable",
  "scan.output-is-input": "invalid",
  "scan.output-stat-failed": "unavailable",
  "scan.stat-failed": "unavailable",
  "scan.walk-failed": "unavailable",
  "write.not-writable": "invalid",
  "write.no-internals": "invalid",
  "write.source-changed": "unavailable",
  "write.read-failed": "unavailable",
  "write.durability": "unavailable",
  "write.failed": "unavailable",
  "read.open-failed": "unavailable",
  "read.not-zip": "invalid",
  "read.malformed": "invalid",
  "read.unsupported-method": "invalid",
  "read.inflate-failed": "invalid",
  "read.size-mismatch": "invalid",
  "read.entry-too-large": "invalid",
  "read.target-collision": "invalid",
  "read.unsafe-path": "invalid",
  "read.no-dest": "invalid",
  "read.write-failed": "unavailable",
  "read.manifest-missing": "invalid",
  "read.manifest-invalid": "invalid",
  "read.manifest-newer": "invalid",
  "io.stalled": "unavailable",
  aborted: "cancelled",
  "internal.unexpected": "internal",
} as const satisfies Record<string, ErrorKind>;

/** A condition the SDK can fail with. */
export type ErrorCode = keyof typeof ERROR_CODES;

/** The fields a code carries beyond the common ones. */
export interface ErrorDetails {
  /** The operation that did not settle within the time budget. */
  "io.stalled": { operation: string; timeoutMs: number };
}

/** A failure as plain data: what an error serializes to and what crosses a
 *  process boundary. */
export interface ZipKitErrorData {
  name: "ZipKitError";
  code: ErrorCode;
  kind: ErrorKind;
  effect: ErrorEffect;
  message: string;
  /** The path or entry the failure concerns, when there is one. */
  subject?: string;
  details?: ErrorDetails[keyof ErrorDetails];
}

export interface ZipKitErrorOptions<C extends ErrorCode> {
  effect?: ErrorEffect;
  subject?: string;
  details?: C extends keyof ErrorDetails ? ErrorDetails[C] : never;
  cause?: unknown;
  settlement?: Promise<void>;
}

export class ZipKitError<C extends ErrorCode = ErrorCode> extends Error implements ZipKitErrorData {
  override readonly name = "ZipKitError";
  readonly code: C;
  readonly kind: ErrorKind;
  readonly effect: ErrorEffect;
  readonly subject: string | undefined;
  readonly details: (C extends keyof ErrorDetails ? ErrorDetails[C] : never) | undefined;
  /** When a write may still land (`effect: "unknown"` from a stalled
   *  publication), the settlement of that physical work, for a caller in the
   *  same process that holds the path until it ends. Never serialized. */
  readonly settlement: Promise<void> | undefined;

  constructor(code: C, message: string, options: ZipKitErrorOptions<C> = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.kind = ERROR_CODES[code];
    this.effect = options.effect ?? "none";
    this.subject = options.subject;
    this.details = options.details;
    this.settlement = options.settlement;
  }

  toJSON(): ZipKitErrorData {
    const data: ZipKitErrorData = { name: "ZipKitError", code: this.code, kind: this.kind, effect: this.effect, message: this.message };
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

/** A file operation that did not settle within its time budget, naming the
 *  operation and the path. When it was publishing a finished file
 *  (`committing`), that work may still land, so the effect is unknown. */
export function stallError(operation: string, path: string, timeoutMs: number, committing: boolean, settlement?: Promise<void>): ZipKitError<"io.stalled"> {
  const message = committing
    ? `${operation} did not finish within ${timeoutMs} ms and may still complete: ${path}`
    : `${operation} did not respond within ${timeoutMs} ms: ${path}`;
  return new ZipKitError("io.stalled", message, {
    effect: committing ? "unknown" : "none",
    subject: path,
    details: { operation, timeoutMs },
    ...(settlement ? { settlement } : {}),
  });
}

/** `err` as a failure that may have left something behind: once an operation
 *  has written part of its output, whatever stopped it leaves the effect
 *  unknown. A value that is not a ZipKit error is returned as it is. */
export function withUnknownEffect(err: unknown): unknown {
  if (!(err instanceof ZipKitError) || err.effect === "unknown") return err;
  const options: ZipKitErrorOptions<ErrorCode> = { effect: "unknown", cause: err.cause };
  if (err.subject !== undefined) options.subject = err.subject;
  if (err.details !== undefined) options.details = err.details as never;
  if (err.settlement !== undefined) options.settlement = err.settlement;
  return new ZipKitError(err.code, err.message, options);
}

/** Whether `err` is a stalled-volume failure. */
export function isStall(err: unknown): err is ZipKitError<"io.stalled"> {
  return err instanceof ZipKitError && err.code === "io.stalled";
}

/** The cancellation error for a signal's reason. */
export function toAbortError(err: unknown, fallback = "operation aborted", effect: ErrorEffect = "none"): ZipKitError<"aborted"> {
  if (err instanceof ZipKitError && err.code === "aborted") return err as ZipKitError<"aborted">;
  if (err instanceof Error) return new ZipKitError("aborted", err.message || fallback, { cause: err, effect });
  return new ZipKitError("aborted", typeof err === "string" && err.length > 0 ? err : fallback, { effect });
}

/** Throw the cancellation error if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}
