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
import type { ArchivePolicy, ArchiveSpec } from "./types.js";

/**
 * The metadata file name must be a single archive-path segment that the name
 * fixer would leave untouched — i.e. held to exactly the same standard as every
 * other archive name. This rejects slashes and traversal (`resolveSegments`),
 * and, via `fixSegment`, anything the fixer would rewrite: non-NFC forms,
 * Windows-invalid characters (including the bare colon a Windows drive prefix
 * needs), control characters, trailing dots/spaces, and reserved device names.
 * So the name is safe both as a ZIP entry name and as a sidecar filename.
 */
function isSafeMetadataName(name: string): boolean {
  const { segments, escaped } = resolveSegments(toForwardSlash(name));
  if (escaped || segments.length !== 1) return false;
  const segment = segments[0] as string;
  return fixSegment(segment, "_").segment === segment;
}

const filterRuleSchema = z
  .strictObject({
    action: z.enum(["include", "exclude"]),
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
  invalidCharReplacement: z.string().optional(),
  symlinks: z.enum(["ignore", "preserve", "follow"]).optional(),
  followExternal: z.boolean().optional(),
  timestamps: z.enum(["clamp", "preserve"]).optional(),
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
          placement: z.enum(["inside", "sidecar"]).optional(),
          hash: z.boolean().optional(),
        })
        // The name becomes an archive entry name (inside) or is joined to the
        // output directory (sidecar), so it must be a single safe path
        // component — never a traversal that would escape the output directory.
        .refine((m) => m.name === undefined || isSafeMetadataName(m.name), {
          error: "metadata.name must be a single path component (no slashes, not '.' or '..')",
          path: ["name"],
        }),
    ])
    .optional(),
  zip64: z.enum(["auto", "never", "always"]).optional(),
  deterministic: z.boolean().optional(),
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

/** Validate an instance-level policy, applying filter-rule defaults. */
export function validatePolicy(policy: Partial<ArchivePolicy>): Partial<ArchivePolicy> {
  const result = partialPolicySchema.safeParse(policy);
  if (!result.success) {
    throw new PolicyError("policy.invalid", `invalid policy: ${formatZodError(result.error)}`);
  }
  return result.data as Partial<ArchivePolicy>;
}
