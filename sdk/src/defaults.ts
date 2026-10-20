/**
 * The built-in policy: what every call starts from when it sets nothing. Plain
 * data with no Node imports and no dependencies, so the browser entry carries
 * it and a window shows the SDK's own defaults instead of restating them.
 */

import { DEFAULT_EXCLUSIONS } from "./filter/defaults.ts";
import type { ArchivePolicy, ManifestPolicy, NameRules } from "./types.ts";

/**
 * The built-in set stored verbatim under `compression.stored: "builtin"`. An
 * extension earns a place only when it is BOTH used often AND almost always
 * already compressed — so attempting deflate wastes CPU with no realistic
 * chance of shrinking. Lowercase, leading dot. This is a CPU optimization, not a
 * correctness setting: any file outside it is still deflated, and
 * `compression.store` only adds to it. The method is decided at plan time and is
 * final — the streaming writer does not reconsider it — so a deflated entry can
 * rarely be a few bytes larger than its stored form.
 *
 * Formats that are common but NOT reliably compressed are deliberately left off,
 * because a wrong "store" guess is a permanent miss: PDF (sometimes compresses),
 * `.iso` (raw image), `.wav`/`.aiff` (PCM), `.bmp`/`.tiff` (often uncompressed),
 * `.ttf`/`.otf` (raw font tables — only `.woff`/`.woff2` are pre-compressed),
 * and `.ts` (almost always TypeScript source, not an MPEG transport stream).
 */
export const DEFAULT_STORE_EXTENSIONS: readonly string[] = [
  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".avif",
  ".jxl",
  // Video
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".wmv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".flv",
  // Audio
  ".mp3",
  ".aac",
  ".m4a",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".wma",
  // Archives (already compressed)
  ".zip",
  ".gz",
  ".7z",
  ".rar",
  ".bz2",
  ".xz",
  ".zst",
  ".tgz",
  ".lz4",
  ".lzma",
  ".br",
  // Documents (zip-based)
  ".docx",
  ".xlsx",
  ".pptx",
  ".docm",
  ".xlsm",
  ".pptm",
  ".odt",
  ".ods",
  ".odp",
  ".epub",
  ".pages",
  ".numbers",
  ".key",
  // Packages (zip-based)
  ".jar",
  ".war",
  ".apk",
  ".ipa",
  ".whl",
  ".nupkg",
  ".vsix",
  ".crx",
  ".xpi",
  ".aar",
  ".egg",
  ".appx",
  ".msix",
  // Comics (zip/rar-based)
  ".cbz",
  ".cbr",
  // Disk images & OS packages (compressed payloads)
  ".dmg",
  ".deb",
  ".rpm",
  // Fonts
  ".woff2",
  ".woff",
];

export const MANIFEST_DEFAULTS: Readonly<ManifestPolicy> = {
  name: "zipkit.json",
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
  invalidCharStyle: "tidy",
  controlChars: "fix",
  trailingDotSpace: "fix",
  reserved: "fix",
  suspicious: "warn",
};

/** `value`, frozen all the way down, so no caller can change the defaults. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The built-in defaults, the policy a call resolves to when it sets nothing.
 * Enumerated-value defaults come first in each union. Frozen: a caller copies
 * what it changes.
 */
export const DEFAULT_POLICY: Readonly<ArchivePolicy> = frozen({
  // Selection
  exclusions: DEFAULT_EXCLUSIONS.map((p) => ({ ...p })),
  emptyFiles: "keep",
  emptyDirs: "keep",

  // Naming
  names: { ...NAME_DEFAULTS },

  // Entry data
  symlinks: "ignore",
  followExternal: false,
  compression: { stored: "builtin", store: [], level: DEFAULT_DEFLATE_LEVEL },

  // Companion output — the embedded manifest record is zipkit's reason to
  // exist (faithful, high-precision persistence), so it is on by default;
  // `manifest: false` opts into a plain archive.
  manifest: { ...MANIFEST_DEFAULTS },
});
