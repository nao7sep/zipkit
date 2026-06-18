/**
 * The mandatory log redactor: the narrow, non-destructive backstop for the day a
 * whole object that happens to carry a secret is logged. It is the single place
 * secret field names are defined, and it runs inside the logger before any event
 * reaches a sink — so a secret is redacted before it leaves the SDK, on every
 * destination at once (the per-session log and the `onProgress` hook).
 *
 * Contract (the logging convention's redaction rules):
 * - match a fixed set of field *names* by exact, case-insensitive name — never
 *   by substring, so `token` never hits `tokenCount` or `broken`;
 * - replace only the matched *value* with `"[redacted]"`; every other field is
 *   byte-identical;
 * - recurse through nested **plain** objects and arrays; any other value — a
 *   primitive, or a non-record object such as a `Date`, `Buffer`, `Map`, `Error`,
 *   or class instance — passes through unchanged, so the redactor can neither
 *   drop a non-record's hidden state nor corrupt it into a bare `{}`;
 * - never regex string values, and never edit the envelope `message` (it is not
 *   a denied key, so it is left untouched by construction — no special case);
 * - pure, total, and type-preserving: it returns a new structure, mutates
 *   nothing, and cannot throw — a self-referential structure is detected and its
 *   back-edge left as-is rather than recursed into forever.
 */

/** Denied field names, lower-cased for case-insensitive exact matching. Each app
 *  owns its own set, seeded with the obvious secrets (there is no cross-app field
 *  taxonomy), and extends it as needed. */
const DENIED_KEYS = new Set(["apikey", "authorization", "token", "password", "secret"]);
const REDACTED = "[redacted]";

/** Return a copy of `value` with the value of every denied key replaced by the
 *  redaction marker. The input is never mutated. */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

/**
 * Only arrays and plain records (`{}` / `Object.create(null)`) are walked. A
 * non-record object — a class instance, `Date`, `Buffer`, `Map`, `Set`, `Error`
 * — is left whole: rebuilding it from `Object.entries` would lose its prototype
 * and any non-enumerable state, corrupting more than it protects.
 */
function isRecord(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (!isRecord(value)) return value;
  // A cycle would otherwise recurse forever; leave the back-edge as-is. Only the
  // current path is tracked (added on descent, removed on unwind), so a shared
  // but acyclic reference is still redacted in each position it appears.
  if (ancestors.has(value)) return value;
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((child) => redactValue(child, ancestors));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = DENIED_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(child, ancestors);
    }
    result = out;
  }
  ancestors.delete(value);
  return result;
}
