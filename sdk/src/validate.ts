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
import { isSafePathComponent, exclusionIssue } from "./input-checks.ts";
import { formatZodError } from "./internal/zodError.ts";
import { isValidTimeZone } from "./internal/timeZone.ts";
import type { ArchivePolicy, ArchiveSpec, DeepPartial, Program, RemovalRequest, VerifyRequest } from "./types.ts";

const exclusionSchema = z
  .strictObject({
    id: z.string().min(1).optional(),
    pattern: z.string().min(1),
    match: z.enum(["glob", "regex"]).default("glob"),
    target: z.enum(["file", "dir", "both"]).default("both"),
    ignoreCase: z.boolean().default(false),
    note: z.string().optional(),
  })
  .refine(
    (rule) => exclusionIssue(rule) !== "regex",
    { error: "invalid regular expression pattern", path: ["pattern"] },
  )
  .refine(
    (rule) => exclusionIssue(rule) !== "target",
    { error: "a glob ending in / names folders, so its target cannot be file", path: ["target"] },
  );

const nameActionSchema = z.enum(["fix", "warn", "error", "none"]);

const partialPolicySchema = z.strictObject({
  exclusions: z.array(exclusionSchema).optional(),
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
 * Validate the streamed-I/O chunk size: an integer number of bytes of at least
 * 64, zlib's minimum. Anything else (smaller, fractional, non-finite) is a
 * caller mistake rejected at the boundary rather than passed to the streams.
 */
export function validateChunkSize(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize < 64) {
    throw new ZipKitError(
      "options.invalid",
      `chunkSize must be an integer number of bytes, at least 64 (got ${chunkSize})`,
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
const CALL_OPTIONS = new Set<string>(["signal", ...CALL_HOOKS]);

/** Refuse any key of `value` outside `known`, as `code`: a misspelt setting
 *  fails the call instead of being silently ignored. */
function refuseUnknownKeys(value: object, known: ReadonlySet<string>, what: string, code: "options.invalid" | "request.invalid"): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new ZipKitError(code, `unknown ${what}: ${unknown.join(", ")}`);
}

/** Per-call options: only the known keys, a signal that is a real AbortSignal
 *  and hooks that are functions, so a wrong value fails as an invalid call
 *  rather than deep in a file operation. */
export function validateCallOptions(options: unknown): void {
  if (options === null || typeof options !== "object") {
    throw new ZipKitError("options.invalid", "call options must be an object");
  }
  refuseUnknownKeys(options, CALL_OPTIONS, "call option", "options.invalid");
  const o = options as Record<string, unknown>;
  if (o.signal !== undefined && !(o.signal instanceof AbortSignal)) {
    throw new ZipKitError("options.invalid", "signal must be an AbortSignal");
  }
  for (const hook of CALL_HOOKS) {
    if (o[hook] !== undefined && typeof o[hook] !== "function") throw new ZipKitError("options.invalid", `${hook} must be a function`);
  }
}

const INSTANCE_OPTIONS = new Set(["policy", "app", "concurrency", "chunkSize", "ioTimeoutMs", "debug"]);

const programSchema = z.strictObject({ name: z.string().min(1).max(256), version: z.string().min(1).max(256).optional() });

/** The app a caller names for its manifests: a name and an optional version,
 *  each short enough that the manifest's size stays bounded. */
export function validateApp(app: unknown): Program {
  const result = programSchema.safeParse(app);
  if (!result.success) throw new ZipKitError("options.invalid", `invalid app: ${formatZodError(result.error)}`);
  return result.data as Program;
}

/** Instance options hold no key the SDK does not know, as specs do not. */
export function validateInstanceOptionKeys(options: unknown): void {
  if (options === null || typeof options !== "object") throw new ZipKitError("options.invalid", "options must be an object");
  refuseUnknownKeys(options, INSTANCE_OPTIONS, "option", "options.invalid");
}

const VERIFY_REQUEST = new Set(["archive", "manifest", "manifestName"]);

/** What `verify` is asked to check: an absolute archive, and only the known
 *  settings, each of its type. */
export function validateVerifyRequest(request: unknown): VerifyRequest {
  if (request === null || typeof request !== "object") throw new ZipKitError("request.invalid", "the verify request must be an object");
  refuseUnknownKeys(request, VERIFY_REQUEST, "verify setting", "request.invalid");
  const r = request as VerifyRequest;
  const checked: VerifyRequest = { archive: requireAbsolute(r.archive, "archive") };
  const manifest = validateFlag(r.manifest, "manifest");
  if (manifest !== undefined) checked.manifest = manifest;
  const manifestName = validateManifestName(r.manifestName);
  if (manifestName !== undefined) checked.manifestName = manifestName;
  return checked;
}

const REMOVAL_REQUEST = new Set(["spec", "archive", "removed"]);

/** What `checkRemoval` is asked to check: a spec, an absolute archive, and
 *  absolute removed inputs; the spec itself is validated as for a plan. */
export function validateRemovalRequest(request: unknown): RemovalRequest {
  if (request === null || typeof request !== "object") throw new ZipKitError("request.invalid", "the removal request must be an object");
  refuseUnknownKeys(request, REMOVAL_REQUEST, "removal setting", "request.invalid");
  const r = request as RemovalRequest;
  const checked: RemovalRequest = { spec: r.spec, archive: requireAbsolute(r.archive, "archive") };
  if (r.removed !== undefined) checked.removed = requireAbsoluteList(r.removed, "removed");
  return checked;
}

/** The name of an embedded manifest: one safe path component. */
function validateManifestName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !isSafePathComponent(name)) {
    throw new ZipKitError("request.invalid", "a manifest name must be a single path component (no slashes, not '.' or '..')");
  }
  return name;
}

/** A switch given as a setting: a boolean when present. */
function validateFlag(value: unknown, what: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new ZipKitError("request.invalid", `${what} must be a boolean`);
}

/** A list of absolute paths, as a verb that takes several paths needs. */
export function requireAbsoluteList(values: unknown, what: string): string[] {
  if (!Array.isArray(values)) throw new ZipKitError("request.invalid", `${what} must be a list of absolute paths`);
  return values.map((value) => requireAbsolute(value as string, `each of ${what}`));
}
