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
  mode: "auto" | "store-all" | "compress-all";
  /** Lowercase extensions (with leading dot) stored verbatim under `"auto"`. */
  storeExtensions: string[];
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
  invalidCharReplacement: string;

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

  // Gating
  strict: boolean;
}

export type ArchiveInput = string | { path: string; as?: string; flatten?: boolean };

export interface ArchiveSpec {
  // Source
  inputs: ArchiveInput[];
  root?: string;

  // Destination
  output?: string;
  overwrite?: boolean;

  // Configuration
  policy?: Partial<ArchivePolicy>;

  // Control
  signal?: AbortSignal;
}

export interface ZipKitOptions {
  policy?: Partial<ArchivePolicy>;
  logger?: (event: LogEvent) => void;
  concurrency?: number;
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

export interface Plan {
  output: string; // identity
  outputExists: boolean; // state
  overwrite: boolean; // state (authorized intent from the spec)
  writable: boolean; // state
  summary: PlanSummary; // quantities (aggregate)
  entries: PlannedEntry[]; // nested detail
  findings: Finding[];
}

export interface WriteResult {
  output: string; // identity
  zip64: boolean; // classification
  entries: number; // quantities
  excluded: number;
  bytes: number;
  /**
   * The complete structured record of the run — the same document embedded as
   * `_metadata.json` (unless `metadata` is `false`). Always present, regardless
   * of whether it was embedded, so a caller can inspect the run without reading
   * the archive back.
   */
  metadata: Metadata;
  plan: Plan; // nested detail
}

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

  // Control
  signal?: AbortSignal;
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

export interface ExtractReport {
  archive: string; // identity
  dest?: string;
  wrote: boolean; // state: whether any file was written
  /** The embedded manifest used, when `checkMetadata` was requested. */
  manifest: { name: string } | null;
  entries: ExtractEntryResult[];
  /** In the manifest but absent from the archive (`checkMetadata`). */
  missing: string[];
  /** In the archive but absent from the manifest (`checkMetadata`). */
  extra: string[];
  findings: Finding[];
  summary: {
    total: number;
    crcFailed: number;
    shaMismatched: number;
    written: number;
    skipped: number;
  };
  /** Overall pass: no CRC failure, no unsafe path, and — under `checkMetadata` —
   *  no missing/extra entry and no SHA mismatch. The delete-gate reads this. */
  ok: boolean;
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
