/**
 * Policy defaults and layering. The resolved policy is what every rule pass
 * reads; it is produced by merging the per-call policy over the instance
 * policy over the built-in defaults. Validation lives in `validate.ts`; this
 * file only assembles a complete {@link ArchivePolicy} from partial layers.
 */

import { defu } from "defu";
import type { ArchivePolicy, MetadataPolicy, NameRules } from "./types.js";

/**
 * The built-in set stored verbatim under `compression.mode: "auto"` — formats
 * that are reliably already compressed, where attempting deflate only wastes
 * CPU with no realistic chance of shrinking. Lowercase, leading dot. This is a
 * CPU optimization, not a correctness setting: any file outside it is still
 * deflated, and `compression.storeExtra` only adds to it. The method is decided
 * at plan time and is final — the streaming writer does not reconsider it — so a
 * deflated entry can rarely be a few bytes larger than its stored form.
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
  // A manifest exists to establish content identity, so the SHA-256 is on by
  // default; omitting it is the deliberate choice. CRC-32 is always present.
  hash: true,
};

/** The default deflate level — zlib's own default, a balanced speed/size point. */
export const DEFAULT_DEFLATE_LEVEL = 6;

/**
 * Name-rule defaults: repair every portability defect we can (`fix`), and flag
 * the unfixable suspicious-character class as a `warning`. Each is individually
 * overridable — a Linux-only user can set the Windows-specific rules to `none`,
 * a CI gate can set any to `error`.
 */
export const NAME_DEFAULTS: NameRules = {
  nfc: "fix",
  invalidChars: "fix",
  invalidCharReplacement: "_",
  controlChars: "fix",
  trailingDotSpace: "fix",
  reserved: "fix",
  suspicious: "warn",
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
  names: { ...NAME_DEFAULTS },
  collisionCase: "insensitive",

  // Entry data
  symlinks: "ignore",
  followExternal: false,
  timestamps: "preserve",
  compression: { mode: "auto", storeExtra: [], level: DEFAULT_DEFLATE_LEVEL },

  // Companion output — the embedded metadata record is zipkit's reason to
  // exist (faithful, high-precision persistence), so it is on by default;
  // `metadata: false` (CLI `--no-metadata`) opts into a plain archive.
  metadata: { ...METADATA_DEFAULTS },

  // Container format
  zip64: "auto",
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

  const storeExtra = firstDefined(
    call?.compression?.storeExtra,
    instance?.compression?.storeExtra,
  );
  merged.compression.storeExtra = storeExtra !== undefined ? storeExtra : [];

  if (merged.metadata !== false) {
    merged.metadata = defu(merged.metadata, METADATA_DEFAULTS) as MetadataPolicy;
  }

  return merged;
}
