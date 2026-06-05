/**
 * The committed public type surface. Every record's keys follow the
 * object-key role sequence: identity, provenance, classification,
 * state/outcome, quantities, subject attributes, nested detail. Configuration
 * surfaces follow the master concern order.
 *
 * The scan layer, the rule passes, and the writer are internal and define
 * their own types elsewhere; nothing here depends on them.
 */

export type Severity = "error" | "warning" | "info";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * An exclusion rule. Every rule excludes — the system is inclusive by default,
 * so a path is kept unless a rule matches it. There is no "include": what goes
 * into an archive is chosen by the inputs, not by re-including. To archive a
 * subset of a tree, narrow the inputs.
 */
export interface FilterRule {
  pattern: string;
  /** Pattern dialect. Defaults to `"glob"`. */
  match: "glob" | "regex" | "literal";
  /** Which entry kinds the rule excludes. Defaults to `"both"`. */
  target: "file" | "dir" | "both";
}

export interface CompressionPolicy {
  /**
   * `auto` stores the built-in set of already-compressed extensions and
   * deflates the rest; `store-all` stores every entry (no compression);
   * `compress-all` deflates every entry (the built-in store set is ignored).
   */
  mode: "auto" | "store-all" | "compress-all";
  /**
   * Extra lowercase extensions (with leading dot) added to the built-in store
   * set under `"auto"`. Additive — there is no way to drop a built-in, because
   * deflating an already-compressed format only wastes CPU; to deflate
   * everything use `compress-all`.
   */
  storeExtra: string[];
  /** Deflate level 1 (fastest) to 9 (smallest); affects only deflated entries. */
  level: number;
}

/**
 * What to do about one class of non-portable name. `fix` repairs the name and
 * records an `info` finding plus the transformation; `warn` leaves it and
 * records a `warning`; `error` leaves it and fails the run; `none` is silent.
 * `name.suspicious` characters are kept by design, so that rule has no `fix`.
 */
export type NameAction = "fix" | "warn" | "error" | "none";

export interface NameRules {
  /** Non-NFC (e.g. macOS NFD) names → NFC. */
  nfc: NameAction;
  /** Windows-illegal characters `< > : " | ? * \`. */
  invalidChars: NameAction;
  /** The substitute for an invalid character; a single safe path component. */
  invalidCharReplacement: string;
  /** Control characters below 0x20. */
  controlChars: NameAction;
  /** Trailing spaces or dots (which Windows silently strips). */
  trailingDotSpace: NameAction;
  /** Reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). */
  reserved: NameAction;
  /** Zero-width and bidirectional-override characters — kept, so never `fix`. */
  suspicious: "warn" | "error" | "none";
}

export interface MetadataPolicy {
  /** The metadata file's entry name; it is always embedded in the archive. */
  name: string;
  /**
   * Compute a SHA-256 per file in addition to the always-present CRC-32.
   * Defaults to `true` whenever metadata is emitted — the manifest's purpose is
   * content identity. Set `false` to record CRC-32 only.
   */
  hash: boolean;
}

/**
 * Processing rules only. Source, destination, and control live on the spec and
 * options; the policy is the portion that decides how each entry is treated.
 * Fields follow the master concern order.
 */
export interface ArchivePolicy {
  // Selection
  junk: "builtin" | "none";
  filters: FilterRule[];
  emptyFiles: "keep" | "skip";
  emptyDirs: "keep" | "prune";
  emptyDirDefinition: "strict" | "recursive";

  // Naming
  names: NameRules;
  /**
   * Whether two archive paths that differ only by case collide. `insensitive`
   * (default) catches clashes that would break on macOS/Windows; `sensitive`
   * allows them, for archives targeting only case-sensitive filesystems.
   */
  collisionCase: "insensitive" | "sensitive";

  // Entry data
  symlinks: "ignore" | "preserve" | "follow";
  followExternal: boolean;
  timestamps: "preserve" | "clamp";
  /**
   * IANA timezone name (e.g. `"Asia/Tokyo"`, `"UTC"`) the ZIP DOS local-time
   * field is rendered in. The DOS field stores local wall-clock with no zone, so
   * a same-zone reader sees the file's real time. Defaults to the host zone.
   * Affects only the DOS field — the extended-timestamp and NTFS extras and the
   * metadata record are always UTC.
   */
  timezone?: string;
  compression: CompressionPolicy;

  // Companion output
  metadata: false | MetadataPolicy;

  // Container format
  zip64: "auto" | "never" | "always";
}

export type ArchiveInput = string | { path: string; as?: string; flatten?: boolean };

export interface ArchiveSpec {
  // Source
  inputs: ArchiveInput[];
  root?: string;

  // Destination
  output?: string;
  overwrite?: boolean;

  // Content
  /** The ZIP end-of-central-directory comment (UTF-8). Recorded in the metadata. */
  comment?: string;

  // Configuration
  policy?: Partial<ArchivePolicy>;
}

export interface ZipKitOptions {
  policy?: Partial<ArchivePolicy>;
  concurrency?: number;
  /**
   * The chunk size, in bytes, for all streamed I/O — the `highWaterMark` of the
   * read/inflate/deflate/write streams. A runtime/performance concern, not a
   * policy: it changes only how the work is buffered, never the archive's bytes.
   * Peak memory is roughly this times `concurrency`. Defaults to 65536 (64 KB).
   */
  chunkSize?: number;
}

/**
 * Per-call control and observation. Both members are per-call rather than
 * per-instance, so each verb call decides where its progress goes and which
 * cancellation it answers to.
 *
 * `onProgress` is the progress hook: with no hook the SDK is silent and pure (it
 * writes to no stream), and the caller decides per call where the event stream
 * goes. The same structured `LogEvent` stream feeds this hook, the CLI's console
 * renderer, and the `--log` JSONL sink — one producer, many sinks.
 *
 * `signal` is the cancellation signal. Every verb — `plan`, `write`, `create`,
 * `extract` — honors it, stopping cleanly at the next boundary (a phase edge, a
 * walked entry, a streamed chunk) and rejecting with {@link AbortError}. It is
 * control, not data, so it lives here and not on the spec.
 */
export interface ZipKitCallOptions {
  onProgress?: (event: LogEvent) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Findings and plan
// ---------------------------------------------------------------------------

export interface Finding {
  rule: string; // identity
  severity: Severity; // classification (sourced from the registry)
  path: string; // locator
  message: string;
  fix?: { kind: "rename" | "exclude" | "normalize-attrs"; to?: string };
}

export interface PlannedEntry {
  archivePath: string; // identity (final, NFC, forward-slash, relative)
  originalPath: string; // identity (as found on disk, pre-fix)
  type: "file" | "dir"; // classification
  method: "store" | "deflate";
  excluded: boolean; // state
  excludeReason?: string;
  findings: Finding[]; // nested detail
}

export interface PlanSummary {
  total: number;
  included: number;
  excluded: number;
  renamed: number;
  warnings: number;
  errors: number;
  zip64: boolean;
}

/**
 * The `create` verb's payload, modeled as a discriminated union on `mode` so
 * neither shape carries a field it cannot honestly fill. A dry run plans but
 * reads/hashes nothing; a real write produces post-write truth (crc/sha/sizes).
 *
 * Per-entry detail is never duplicated: `mode:"plan"` carries `entries`
 * (pre-write, no crc/sha); `mode:"write"` carries the post-write per-entry SSOT
 * inside `metadata.entries`. `plan()` returns the `"plan"` member; `write()` and
 * `create()` return the `"write"` member (or throw on an operational fault).
 */
export type CreateData =
  | {
      mode: "plan"; // --dry-run: planned, nothing written
      output: string; // resolved output path (the intended target)
      writable: boolean; // the gate
      summary: PlanSummary;
      findings: Finding[]; // SSOT
      entries: PlannedEntry[]; // pre-write view (no crc/sha)
    }
  | {
      mode: "write"; // actual create
      output: string;
      writable: boolean;
      written: boolean; // archive fully streamed, fsync'd, renamed?
      bytes: number | null; // final on-disk size; null if not written
      zip64: boolean;
      summary: PlanSummary;
      findings: Finding[]; // SSOT (domain + operational)
      /**
       * The embedded `_metadata.json` document = the post-write per-entry SSOT
       * (crc/sha/sizes/times). `null` only if a fault hit before it was built.
       */
      metadata: Metadata | null;
    };

// ---------------------------------------------------------------------------
// Metadata record
// ---------------------------------------------------------------------------

/** A UTC instant as both its lossless nanosecond count and an ISO-8601 string. */
export interface UtcTime {
  ns: string;
  iso: string;
}

/** One name fix applied to an entry. `rule` is a `RuleId`. */
export interface Transformation {
  rule: string;
  before: string;
  after: string;
}

/** One written entry's record in the {@link Metadata} document. */
export interface MetadataEntry {
  archivePath: string; // identity
  originalPath: string;
  sourcePath: string;
  type: "file" | "dir" | "symlink"; // classification
  method: "store" | "deflate";
  size: number; // quantities
  compressedSize: number;
  crc32: number;
  /** Present when hashing was enabled (the default). */
  sha256?: string;
  mode: number;
  mtime: UtcTime; // subject attributes (UTC)
  atime: UtcTime;
  ctime: UtcTime;
  /** Creation time, or `null` when the platform does not track it. */
  btime: UtcTime | null;
  linkTarget?: string;
  transformations: Transformation[]; // nested detail
}

/** A dropped entry's record in the {@link Metadata} document. */
export interface MetadataExcluded {
  archivePath: string;
  originalPath: string;
  type: "file" | "dir" | "symlink";
  reason?: string;
}

/**
 * The lossless structured record of an archive run: header, per-entry records,
 * dropped entries, and findings. Returned from every `create` and embedded as
 * `_metadata.json` unless disabled.
 */
export interface Metadata {
  tool: string; // identity
  version: string; // provenance
  createdUtc: UtcTime;
  /** The IANA zone the DOS local-time fields were rendered in. */
  timeZone: string;
  /** The archive comment, present only when one was set. */
  comment?: string;
  policy: ArchivePolicy; // configuration
  summary: PlanSummary; // quantities (aggregate)
  totals: { uncompressedBytes: number; compressedBytes: number };
  entries: MetadataEntry[]; // nested detail
  excluded: MetadataExcluded[];
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Extract / validate
// ---------------------------------------------------------------------------

/**
 * One read operation drives both extraction and validation. The two switches
 * are orthogonal: `dryRun` decides whether files are written, `checkMetadata`
 * decides whether the archive is reconciled against its manifest. CRC-32 is
 * always verified — every entry is decompressed regardless — so a dry run with
 * no other option is a pure integrity test (`unzip -t`), and it works on any
 * ZIP, not only ones zipkit produced.
 */
export interface ExtractSpec {
  // Source
  archive: string;

  // Destination
  /** Output directory. Required unless `dryRun` is set; ignored on a dry run. */
  dest?: string;
  overwrite?: boolean;

  // Mode
  /** Verify only, write nothing. */
  dryRun?: boolean;
  /** Reconcile entries against the manifest and verify recorded SHA-256s. */
  checkMetadata?: boolean;
  /** Manifest entry name to look for inside the archive. */
  metadataName?: string;

  // Restore policy (write only)
  /** Restore modification/access times to extracted files. Defaults to `restore`. */
  timestamps?: "restore" | "none";
  /** Zone used to interpret the DOS field when an entry has no UTC time extra. */
  timezone?: string;
  /** Handling of entries whose path escapes `dest`. Defaults to `skip`. */
  onUnsafe?: "skip" | "abort";
  /** Whether to recreate symlink entries. Defaults to `restore`. */
  symlinks?: "restore" | "skip";
  /**
   * Exclusion rules. A matching entry is still verified (CRC, and SHA under
   * `checkMetadata`) but is not written to disk — filtering selects output,
   * integrity always covers the whole archive.
   */
  exclude?: FilterRule[];
}

export interface ExtractEntryResult {
  archivePath: string; // identity
  type: "file" | "dir" | "symlink"; // classification
  crc: "ok" | "fail"; // outcome: content integrity
  /** Identity against the manifest, present only under `checkMetadata`. */
  sha?: "ok" | "mismatch" | "absent";
  written: boolean; // state
  /** Why an entry was not written, when it was not. */
  skipped?: "dry-run" | "crc-fail" | "unsafe" | "excluded" | "exists" | "symlink-skip";
  outputPath?: string;
}

/**
 * The `extract` verb's payload. `findings` is the SSOT fault carrier. The domain
 * verdict is `reportOk` — no CRC failure, no unsafe path, and (under
 * `checkMetadata`) no missing/extra entry and no SHA mismatch — distinct from
 * the envelope's derived `ok`; a clean run that is simply "not ok" exits 1, and
 * the CLI keys that gate off `reportOk`.
 */
export interface ExtractData {
  archive: string; // identity
  dest: string | null; // null on --dry-run
  dryRun: boolean;
  wrote: boolean; // state: whether any file was written
  reportOk: boolean; // domain verdict (the delete-gate reads this)
  /** The embedded manifest used, when `checkMetadata` was requested. */
  manifest: { name: string } | null;
  summary: {
    total: number;
    written: number;
    skipped: number;
    crcFailed: number;
    shaMismatched: number;
  };
  entries: ExtractEntryResult[];
  /** In the manifest but absent from the archive (`checkMetadata`). */
  missing: string[];
  /** In the archive but absent from the manifest (`checkMetadata`). */
  extra: string[];
  findings: Finding[]; // SSOT
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface LogEvent {
  ts: string; // time of emission, ISO 8601 UTC
  stage: "scan" | "plan" | "write" | "extract"; // classification
  level: "debug" | "info" | "warn" | "error";
  message: string;
  rule?: string; // context
  path?: string;
  data?: Record<string, unknown>; // payload
}
