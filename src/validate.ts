/**
 * Spec and policy validation at the SDK boundary. Malformed input is rejected
 * with a `PolicyError` rather than allowed to fail deep inside a pass. Filter
 * rules gain their `match`/`target` defaults here, so every rule that reaches
 * the engine is complete. The `signal` is not serializable and is carried
 * around the schema, then re-attached.
 */

import { z } from "zod";
import { PolicyError } from "./errors.js";
import { resolveSegments, toForwardSlash } from "./internal/path.js";
import { formatZodError } from "./internal/zodError.js";
import { fixSegment } from "./plan/nameFix.js";
import { isValidTimeZone } from "./internal/timeZone.js";
import type { ArchivePolicy, ArchiveSpec, ExtractSpec } from "./types.js";

/**
 * A single archive-path segment that the name fixer would leave untouched — the
 * standard every archive name is held to. This rejects slashes and traversal
 * (`resolveSegments`), and, via `fixSegment`, anything the fixer would rewrite:
 * non-NFC forms, Windows-invalid characters (including the bare colon a Windows
 * drive prefix needs), control characters, trailing dots/spaces, and reserved
 * device names.
 *
 * Two uses share it. The metadata file name must satisfy it so the name is safe
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
  return fixSegment(segment, "_").segment === segment;
}

const filterRuleSchema = z
  .strictObject({
    pattern: z.string(),
    match: z.enum(["glob", "regex", "literal"]).default("glob"),
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

const partialPolicySchema = z.strictObject({
  junk: z.enum(["builtin", "none"]).optional(),
  filters: z.array(filterRuleSchema).optional(),
  emptyFiles: z.enum(["keep", "skip"]).optional(),
  emptyDirs: z.enum(["keep", "prune"]).optional(),
  emptyDirDefinition: z.enum(["strict", "recursive"]).optional(),
  // Substituted into a single segment after the path-traversal pass, so it must
  // itself be a clean single component — never a separator or a `..` that would
  // re-introduce an absolute or traversing entry name.
  invalidCharReplacement: z
    .string()
    .optional()
    .refine((r) => r === undefined || isSafePathComponent(r), {
      error: "invalidCharReplacement must be a single path component (no slashes, not '.' or '..')",
    }),
  symlinks: z.enum(["ignore", "preserve", "follow"]).optional(),
  followExternal: z.boolean().optional(),
  timestamps: z.enum(["preserve", "clamp"]).optional(),
  // An IANA Time Zone Database name the runtime accepts (offsets and POSIX TZ
  // strings are rejected, so DST is always handled correctly).
  timezone: z
    .string()
    .optional()
    .refine((tz) => tz === undefined || isValidTimeZone(tz), {
      error: "timezone must be a valid IANA time zone name (e.g. 'Asia/Tokyo', 'UTC')",
    }),
  compression: z
    .strictObject({
      mode: z.enum(["auto", "store-all", "compress-all"]).optional(),
      storeExtensions: z.array(z.string()).optional(),
    })
    .optional(),
  metadata: z
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
          error: "metadata.name must be a single path component (no slashes, not '.' or '..')",
          path: ["name"],
        }),
    ])
    .optional(),
  zip64: z.enum(["auto", "never", "always"]).optional(),
  strict: z.boolean().optional(),
});

const archiveInputSchema = z.union([
  z.string(),
  z.strictObject({
    path: z.string(),
    as: z.string().optional(),
    flatten: z.boolean().optional(),
  }),
]);

const specSchema = z.strictObject({
  inputs: z.array(archiveInputSchema).min(1),
  root: z.string().optional(),
  output: z.string().optional(),
  overwrite: z.boolean().optional(),
  policy: partialPolicySchema.optional(),
});

/**
 * Validate a spec, returning it with filter-rule defaults applied. The runtime
 * shape produced by the schema is a structural superset of the partial policy
 * type (nested objects may be partial); `resolvePolicy` completes it.
 */
export function validateSpec(spec: ArchiveSpec): ArchiveSpec {
  const { signal, ...rest } = spec;
  const result = specSchema.safeParse(rest);
  if (!result.success) {
    throw new PolicyError("spec.invalid", `invalid archive spec: ${formatZodError(result.error)}`);
  }
  const data = result.data as Omit<ArchiveSpec, "signal">;
  return signal ? { ...data, signal } : { ...data };
}

const extractSpecSchema = z.strictObject({
  archive: z.string(),
  dest: z.string().optional(),
  overwrite: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  checkMetadata: z.boolean().optional(),
  // Becomes an archive entry name or is joined to the archive's directory, so it
  // must be a single safe path component — never a traversal.
  metadataName: z
    .string()
    .optional()
    .refine((name) => name === undefined || isSafePathComponent(name), {
      error: "metadataName must be a single path component (no slashes, not '.' or '..')",
    }),
  timestamps: z.enum(["restore", "none"]).optional(),
  timezone: z
    .string()
    .optional()
    .refine((tz) => tz === undefined || isValidTimeZone(tz), {
      error: "timezone must be a valid IANA time zone name (e.g. 'Asia/Tokyo', 'UTC')",
    }),
  onUnsafe: z.enum(["skip", "abort"]).optional(),
  symlinks: z.enum(["restore", "skip"]).optional(),
  exclude: z.array(filterRuleSchema).optional(),
});

/** Validate an extract spec; the non-serializable `signal` is carried around it. */
export function validateExtractSpec(spec: ExtractSpec): ExtractSpec {
  const { signal, ...rest } = spec;
  const result = extractSpecSchema.safeParse(rest);
  if (!result.success) {
    throw new PolicyError(
      "spec.invalid",
      `invalid extract spec: ${formatZodError(result.error)}`,
    );
  }
  const data = result.data as Omit<ExtractSpec, "signal">;
  return signal ? { ...data, signal } : { ...data };
}

/**
 * Validate the streamed-I/O chunk size: a positive integer number of bytes.
 * Anything else (zero, negative, fractional, non-finite) is a caller mistake
 * rejected at the boundary rather than passed to a stream's `highWaterMark`.
 */
export function validateChunkSize(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new PolicyError(
      "options.invalid",
      `chunkSize must be a positive integer number of bytes (got ${chunkSize})`,
    );
  }
  return chunkSize;
}

/** Validate an instance-level policy, applying filter-rule defaults. */
export function validatePolicy(policy: Partial<ArchivePolicy>): Partial<ArchivePolicy> {
  const result = partialPolicySchema.safeParse(policy);
  if (!result.success) {
    throw new PolicyError("policy.invalid", `invalid policy: ${formatZodError(result.error)}`);
  }
  return result.data as Partial<ArchivePolicy>;
}
