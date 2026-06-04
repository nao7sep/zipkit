/**
 * Policy defaults and layering. The resolved policy is what every rule pass
 * reads; it is produced by merging the per-call policy over the instance
 * policy over the built-in defaults. Validation lives in `validate.ts`; this
 * file only assembles a complete {@link ArchivePolicy} from partial layers.
 */

import { defu } from "defu";
import type { ArchivePolicy, MetadataPolicy } from "./types.js";

/**
 * Extensions stored verbatim under `compression.mode: "auto"` — formats that
 * are reliably already compressed, where attempting deflate only wastes CPU
 * with no realistic chance of shrinking. Lowercase, leading dot. This list is
 * a CPU optimization, not a correctness setting: any file outside it is still
 * deflated, and any entry whose deflate fails to shrink falls back to store.
 * Borderline formats (e.g. PDF, which sometimes compresses) are deliberately
 * left off so `auto` can keep the win when it exists.
 */
export const DEFAULT_STORE_EXTENSIONS: readonly string[] = [
  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  // Video
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  // Audio
  ".mp3",
  ".aac",
  ".m4a",
  ".flac",
  // Archives
  ".zip",
  ".gz",
  ".7z",
  ".rar",
  // Office (zip-based)
  ".docx",
  ".xlsx",
  ".pptx",
  // Fonts
  ".woff2",
];

export const METADATA_DEFAULTS: MetadataPolicy = {
  name: "_metadata.json",
  placement: "inside",
  hash: false,
};

/**
 * The built-in defaults. Enumerated-value defaults come first in each union.
 * `emptyDirDefinition` defaults to `"recursive"`, matching the CLI's
 * documented default and the intuitive reading — a directory
 * holding only empty files and empty subdirectories counts as empty.
 */
export const DEFAULT_POLICY: ArchivePolicy = {
  // Selection
  junk: "builtin",
  filters: [],
  emptyFiles: "keep",
  emptyDirs: "keep",
  emptyDirDefinition: "recursive",

  // Naming
  invalidCharReplacement: "_",

  // Entry data
  symlinks: "ignore",
  followExternal: false,
  timestamps: "clamp",
  compression: { mode: "auto", storeExtensions: [...DEFAULT_STORE_EXTENSIONS] },

  // Companion output
  metadata: false,

  // Container format
  zip64: "auto",
  deterministic: false,

  // Gating
  strict: false,
};

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Merge the per-call policy over the instance policy over the defaults.
 * `defu` deep-merges scalars and nested objects, but concatenates arrays; for
 * the two list-valued fields a more specific layer must replace the broader
 * one, so they are resolved explicitly afterward.
 */
export function resolvePolicy(
  instance?: Partial<ArchivePolicy>,
  call?: Partial<ArchivePolicy>,
): ArchivePolicy {
  // Clone the defaults so a resolved policy never shares nested objects (e.g.
  // `compression`) with the module-global default; `defu` does not deep-clone
  // its last source.
  const merged = defu(call ?? {}, instance ?? {}, structuredClone(DEFAULT_POLICY)) as ArchivePolicy;

  const filters = firstDefined(call?.filters, instance?.filters);
  merged.filters = filters !== undefined ? filters : [];

  const storeExtensions = firstDefined(
    call?.compression?.storeExtensions,
    instance?.compression?.storeExtensions,
  );
  merged.compression.storeExtensions =
    storeExtensions !== undefined ? storeExtensions : [...DEFAULT_STORE_EXTENSIONS];

  if (merged.metadata !== false) {
    merged.metadata = defu(merged.metadata, METADATA_DEFAULTS) as MetadataPolicy;
  }

  return merged;
}
