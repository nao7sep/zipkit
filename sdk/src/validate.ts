/**
 * Spec and policy validation at the SDK boundary. Malformed input is rejected
 * with a `ZipKitError` of kind `invalid` rather than allowed to fail deep inside a pass. Filter
 * rules gain their `match`/`target` defaults here, so every rule that reaches
 * the engine is complete. A spec is pure serializable data — cancellation is
 * per-call control on {@link ZipKitCallOptions}, not a spec field — so the whole
 * object is validated directly with nothing carried around the schema.
 */

import path from "node:path";
import { z } from "zod";
import { ZipKitError } from "./errors.ts";
import { resolveSegments, toForwardSlash } from "./internal/path.ts";
import { formatZodError } from "./internal/zodError.ts";
import { fullFixSegment } from "./plan/nameFix.ts";
import { isValidTimeZone } from "./internal/timeZone.ts";
import type { ArchivePolicy, ArchiveSpec, DeepPartial } from "./types.ts";

/**
 * A single archive-path segment that the name fixer would leave untouched — the
 * standard every archive name is held to. This rejects slashes and traversal
 * (`resolveSegments`), and, via `fixSegment`, anything the fixer would rewrite:
 * non-NFC forms, Windows-invalid characters (including the bare colon a Windows
 * drive prefix needs), control characters, trailing dots/spaces, and reserved
 * device names.
 *
 * Two uses share it. The manifest name must satisfy it so the name is safe
 * as a ZIP entry. The invalid-char replacement
 * must satisfy it too: `name.invalid-char` substitutes it into a segment after
 * the path-traversal pass has already run (see `nameFix.ts`), so a replacement
 * carrying a separator or resolving to `..` would re-introduce exactly the
 * absolute/traversal paths that pass stripped — holding it to a clean single
 * component closes that off at the boundary rather than mid-pipeline.
 */
function isSafePathComponent(name: string): boolean {
  const { segments, escaped } = resolveSegments(toForwardSlash(name));
  if (escaped || segments.length !== 1) return false;
  const segment = segments[0] as string;
  return fullFixSegment(segment, "_") === segment;
}

const filterRuleSchema = z
  .strictObject({
    pattern: z.string(),
    match: z.enum(["glob", "regex"]).default("glob"),
    target: z.enum(["file", "dir", "both"]).default("both"),
  })
  .refine(
    (rule) => {
      if (rule.match !== "regex") return true;
      try {
        new RegExp(rule.pattern);
        return true;
      } catch {
        return false;
      }
    },
    { error: "invalid regular expression pattern", path: ["pattern"] },
  );

const nameActionSchema = z.enum(["fix", "warn", "error", "none"]);

const partialPolicySchema = z.strictObject({
  junk: z.enum(["builtin", "none"]).optional(),
  filters: z.array(filterRuleSchema).optional(),
  emptyFiles: z.enum(["keep", "skip"]).optional(),
  emptyDirs: z.enum(["keep", "prune"]).optional(),
  names: z
    .strictObject({
      nfc: nameActionSchema.optional(),
      invalidChars: nameActionSchema.optional(),
      // Substituted into a single segment after the path-traversal pass, so it
      // must itself be a clean single component — never a separator or a `..`
      // that would re-introduce an absolute or traversing entry name.
      invalidCharReplacement: z
        .string()
        .optional()
        .refine((r) => r === undefined || isSafePathComponent(r), {
          error:
            "names.invalidCharReplacement must be a single path component (no slashes, not '.' or '..')",
          path: ["invalidCharReplacement"],
        }),
      invalidCharStyle: z.enum(["tidy", "replace", "fullwidth", "remove"]).optional(),
      controlChars: nameActionSchema.optional(),
      trailingDotSpace: nameActionSchema.optional(),
      reserved: nameActionSchema.optional(),
      suspicious: z.enum(["warn", "error", "none"]).optional(),
    })
    .optional(),
  symlinks: z.enum(["ignore", "preserve", "follow"]).optional(),
  followExternal: z.boolean().optional(),
  // An IANA Time Zone Database name the runtime accepts (offsets and POSIX TZ
  // strings are rejected, so DST is always handled correctly).
  timeZone: z
    .string()
    .optional()
    .refine((tz) => tz === undefined || isValidTimeZone(tz), {
      error: "timeZone must be a valid IANA time zone name (e.g. 'Asia/Tokyo', 'UTC')",
    }),
  compression: z
    .strictObject({
      stored: z.enum(["builtin", "none"]).optional(),
      store: z.array(z.string()).optional(),
      level: z.number().int().min(1).max(9).optional(),
    })
    .optional(),
  manifest: z
    .union([
      z.literal(false),
      z
        .strictObject({
          name: z.string().optional(),
          hash: z.boolean().optional(),
        })
        // The name becomes an archive entry name, so it must be a single safe
        // path component — never a traversal that would escape the archive root.
        .refine((m) => m.name === undefined || isSafePathComponent(m.name), {
          error: "manifest.name must be a single path component (no slashes, not '.' or '..')",
          path: ["name"],
        }),
    ])
    .optional(),
});

/** A location the caller gives: the SDK resolves nothing against a working
 *  directory, so every path it is handed is absolute. */
const absolutePath = (what: string) =>
  z.string().refine((p) => p !== "" && path.isAbsolute(p), { error: `${what} must be an absolute path` });

const specSchema = z.strictObject({
  inputs: z.array(absolutePath("each input")).min(1),
  output: absolutePath("output").optional(),
  outputDir: absolutePath("outputDir").optional(),
  // A file name, never a path: it is joined to the folder as one component.
  outputName: z
    .string()
    .refine((n) => n.trim() !== "" && !/[\\/]/.test(n) && n.trim() !== "." && n.trim() !== "..", {
      error: "outputName must be a single file name (no slashes, not '.' or '..')",
    })
    .optional(),
  overwrite: z.boolean().optional(),
  // The ZIP EOCD comment-length field is 16-bit, so the UTF-8 encoding must fit
  // in 65535 bytes.
  comment: z
    .string()
    .optional()
    .refine((c) => c === undefined || Buffer.byteLength(c, "utf8") <= 0xffff, {
      error: "comment must be at most 65535 bytes when UTF-8 encoded",
    }),
  policy: partialPolicySchema.optional(),
}).refine((s) => s.output === undefined || (s.outputDir === undefined && s.outputName === undefined), {
  error: "give either output, or outputDir and outputName, not both",
  path: ["output"],
});

/**
 * Validate a spec, returning it with filter-rule defaults applied. The runtime
 * shape produced by the schema is a structural superset of the partial policy
 * type (nested objects may be partial); `resolvePolicy` completes it.
 */
export function validateSpec(spec: ArchiveSpec): ArchiveSpec {
  const result = specSchema.safeParse(spec);
  if (!result.success) {
    throw new ZipKitError("spec.invalid", `invalid archive spec: ${formatZodError(result.error)}`);
  }
  return result.data as ArchiveSpec;
}

/**
 * Validate the streamed-I/O chunk size: a positive integer number of bytes.
 * Anything else (zero, negative, fractional, non-finite) is a caller mistake
 * rejected at the boundary rather than passed to a stream's `highWaterMark`.
 */
export function validateChunkSize(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new ZipKitError(
      "options.invalid",
      `chunkSize must be a positive integer number of bytes (got ${chunkSize})`,
    );
  }
  return chunkSize;
}

/** The largest delay a timer can hold (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Validate the per-operation filesystem budget: a positive integer number of
 * milliseconds a timer can represent. Like {@link validateChunkSize} it is a
 * runtime knob whose bound the SDK owns.
 */
export function validateIoTimeout(ioTimeoutMs: number): number {
  if (!Number.isInteger(ioTimeoutMs) || ioTimeoutMs <= 0 || ioTimeoutMs > MAX_TIMER_MS) {
    throw new ZipKitError(
      "options.invalid",
      `ioTimeoutMs must be a positive integer number of milliseconds up to ${MAX_TIMER_MS} (got ${ioTimeoutMs})`,
    );
  }
  return ioTimeoutMs;
}

/**
 * Validate the concurrency limit: a positive integer count of in-flight file
 * operations. Like {@link validateChunkSize} this is a runtime knob, not policy,
 * but its bound is still the SDK's to own — a non-positive or fractional value
 * is a caller mistake rejected at the boundary rather than silently defaulted.
 */
export function validateConcurrency(concurrency: number): number {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new ZipKitError(
      "options.invalid",
      `concurrency must be a positive integer (got ${concurrency})`,
    );
  }
  return concurrency;
}

/** Validate the debug switch: a boolean when given (`false` when unset). */
export function validateDebug(debug: unknown): boolean {
  if (debug === undefined) return false;
  if (typeof debug !== "boolean") throw new ZipKitError("options.invalid", `debug must be a boolean (got ${String(debug)})`);
  return debug;
}

/** Validate an instance-level policy, applying filter-rule defaults. */
export function validatePolicy(policy: DeepPartial<ArchivePolicy>): DeepPartial<ArchivePolicy> {
  const result = partialPolicySchema.safeParse(policy);
  if (!result.success) {
    throw new ZipKitError("policy.invalid", `invalid policy: ${formatZodError(result.error)}`);
  }
  return result.data as DeepPartial<ArchivePolicy>;
}

/** A path handed to a verb on its own, outside a spec: it must be absolute,
 *  since the SDK resolves nothing against a working directory. */
export function requireAbsolute(value: string, what: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ZipKitError("path.not-absolute", `${what} must be an absolute path (got ${String(value)})`, { subject: String(value) });
  }
  return value;
}

const CALL_HOOKS = ["onEvent", "onProgress", "onPhysicalSettlement"] as const;

/** Per-call options: a signal that is a real AbortSignal and hooks that are
 *  functions, so a wrong value fails as an invalid call rather than deep in
 *  a file operation. */
export function validateCallOptions(options: unknown): void {
  if (options === null || typeof options !== "object") {
    throw new ZipKitError("options.invalid", "call options must be an object");
  }
  const o = options as Record<string, unknown>;
  if (o.signal !== undefined && !(o.signal instanceof AbortSignal)) {
    throw new ZipKitError("options.invalid", "signal must be an AbortSignal");
  }
  for (const hook of CALL_HOOKS) {
    if (o[hook] !== undefined && typeof o[hook] !== "function") throw new ZipKitError("options.invalid", `${hook} must be a function`);
  }
}

const INSTANCE_OPTIONS = new Set(["policy", "concurrency", "chunkSize", "ioTimeoutMs", "debug"]);

/** Instance options hold no key the SDK does not know, as specs do not. */
export function validateInstanceOptionKeys(options: unknown): void {
  if (options === null || typeof options !== "object") throw new ZipKitError("options.invalid", "options must be an object");
  const unknown = Object.keys(options).filter((key) => !INSTANCE_OPTIONS.has(key));
  if (unknown.length > 0) throw new ZipKitError("options.invalid", `unknown option: ${unknown.join(", ")}`);
}

/** The name of an embedded manifest: one safe path component. */
export function validateManifestName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !isSafePathComponent(name)) {
    throw new ZipKitError("options.invalid", "a manifest name must be a single path component (no slashes, not '.' or '..')");
  }
  return name;
}

/** A switch given as an option: a boolean when present. */
export function validateFlag(value: unknown, what: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new ZipKitError("options.invalid", `${what} must be a boolean`);
}

/** A list of absolute paths, as a verb that takes several paths needs. */
export function requireAbsoluteList(values: unknown, what: string): string[] {
  if (!Array.isArray(values)) throw new ZipKitError("options.invalid", `${what} must be a list of absolute paths`);
  return values.map((value) => requireAbsolute(value as string, `each of ${what}`));
}
