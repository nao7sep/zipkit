import type { ZipKitErrorData } from "./errors.ts";

/**
 * The committed public type surface. Every record's keys follow the
 * object-key role sequence: identity, provenance, classification,
 * state/outcome, quantities, subject attributes, nested detail. Configuration
 * surfaces follow the master concern order.
 *
 * The scan layer, the rule passes, and the writer are internal and define
 * their own types elsewhere; nothing here depends on them.
 */


/** Every value of each closed set below, as data: a check of plain data a
 *  caller hands back reads its allowed values from here, never from a copy. */
export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Recursively optional, but treating arrays as atomic — a provided list replaces
 * the default wholesale (see `mergePolicy`), so its elements stay complete. This
 * is the accurate type for policy input: callers may give a nested object with
 * only the fields they care about, and `resolvePolicy` completes the rest from
 * the defaults.
 */
export type DeepPartial<T> = T extends ReadonlyArray<unknown>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * One exclusion pattern. Every pattern excludes: the system is inclusive by
 * default, so a path is kept unless a pattern matches it. There is no
 * "include": what goes into an archive is chosen by the inputs. A glob
 * without a slash matches a name at any depth, one with a slash is anchored
 * to the archive root, `**` spans folders and a trailing slash marks a
 * folder; a regex matches the archive path anywhere unless anchored.
 */
export interface ExclusionPattern {
  /** A stable id, which every built-in pattern carries (`macos.ds-store`), so
   *  a caller recognizes it again whatever its text or note says; a caller's
   *  own pattern may carry one of its own. Recorded in the manifest. */
  id?: string;
  pattern: string;
  /** Pattern dialect. Defaults to `"glob"`. */
  match: "glob" | "regex";
  /** Which entry kinds it excludes. Defaults to `"both"`. */
  target: "file" | "dir" | "both";
  /** Match regardless of case. Defaults to `false`. */
  ignoreCase: boolean;
  /** A note on where the pattern comes from or what it is for, such as
   *  `macOS`; shown beside it, never matched, and not recorded in the manifest. */
  note?: string;
}

/** The exclusion pattern that left an entry out: its id when it has one, and
 *  its text. */
export interface ExcludedBy {
  id?: string;
  pattern: string;
}

export interface CompressionPolicy {
  /**
   * The baseline set of extensions kept stored (uncompressed). `builtin` seeds
   * it with the curated already-compressed formats and deflates the rest;
   * `none` seeds it empty, so everything is deflated unless `store` lists it.
   */
  stored: "builtin" | "none";
  /**
   * Extra extensions added to the baseline store set. Given with or without a
   * leading dot and in any case — `.txt`, `txt`, and `.TXT` are equivalent and
   * normalized to lowercase-dotted form. With `stored: "builtin"` they extend
   * the curated set; with `stored: "none"` they are the only stored extensions.
   */
  store: string[];
  /** Deflate level 1 (fastest) to 9 (smallest); affects only deflated entries. */
  level: number;
}

/**
 * What to do about one class of non-portable name. `fix` repairs the name and
 * records an `info` finding plus the name fix; `warn` leaves it and
 * records a `warning`; `error` leaves it and fails the run; `none` is silent.
 * `name.suspicious` characters are kept by design, so that rule has no `fix`.
 */
export type NameAction = "fix" | "warn" | "error" | "none";

/**
 * How characters Windows forbids in names are replaced when they are fixed:
 *
 * - `tidy` (the default): a run of them becomes one `invalidCharReplacement`,
 *   and a run at either end of the name or beside a space is dropped, so
 *   `How are you???.url` becomes `How are you.url` and `a:b` becomes `a_b`;
 * - `replace`: each one becomes `invalidCharReplacement` (`How are you___.url`);
 * - `fullwidth`: each one becomes its full-width look-alike, which Windows
 *   allows (`How are you？？？.url`);
 * - `remove`: each one is deleted, and the spaces around it tidied.
 */
export type InvalidCharStyle = "tidy" | "replace" | "fullwidth" | "remove";

export interface NameRules {
  /** Non-NFC (e.g. macOS NFD) names → NFC. */
  nfc: NameAction;
  /** Windows-illegal characters `< > : " | ? * \`. */
  invalidChars: NameAction;
  /** The substitute for an invalid character; a single safe path component. */
  invalidCharReplacement: string;
  /** How invalid characters are replaced when they are fixed. */
  invalidCharStyle: InvalidCharStyle;
  /** Control characters below 0x20. */
  controlChars: NameAction;
  /** Trailing spaces or dots (which Windows silently strips). */
  trailingDotSpace: NameAction;
  /** Reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). */
  reserved: NameAction;
  /** Zero-width and bidirectional-override characters — kept, so never `fix`. */
  suspicious: "warn" | "error" | "none";
}

export interface ManifestPolicy {
  /** The manifest's entry name; it is always embedded in the archive. */
  name: string;
  /**
   * Compute a SHA-256 per file in addition to the always-present CRC-32.
   * Defaults to `true` whenever a manifest is written — the manifest's purpose is
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
  /** What to leave out, the whole list: the first pattern that matches a path
   *  excludes it. Defaults to `DEFAULT_EXCLUSIONS`; an empty list keeps
   *  everything. */
  exclusions: ExclusionPattern[];
  emptyFiles: "keep" | "skip";
  emptyDirs: "keep" | "prune";

  // Naming
  names: NameRules;

  // Entry data
  symlinks: "ignore" | "preserve" | "follow";
  followExternal: boolean;
  /**
   * IANA time zone name (e.g. `"Asia/Tokyo"`, `"UTC"`) the ZIP DOS local-time
   * field is rendered in. The DOS field stores local wall-clock with no zone, so
   * a same-zone reader sees the file's real time. Defaults to the host zone.
   * Affects only the DOS field, whose 1980–2107 range (and so the `time.pre-1980`
   * and `time.post-2107` findings) is judged in this zone — the
   * extended-timestamp and NTFS extras and the manifest are always UTC.
   */
  timeZone?: string;
  compression: CompressionPolicy;

  // Companion output
  manifest: false | ManifestPolicy;
}

/**
 * One archive source: a file or directory path. A single directory input has its
 * contents flattened to the archive root (the output filename already carries
 * the directory's name); multiple inputs each keep their basename as a top-level
 * folder, with files landing bare, so distinct inputs cannot silently merge.
 */
export type ArchiveInput = string;

export interface ArchiveSpec {
  // Source
  inputs: ArchiveInput[];

  // Destination
  /** The archive's full path. Give this, or `outputDir` and `outputName`, or
   *  neither, to have the archive written beside what it archives. */
  output?: string;
  /** The folder the archive goes in; inferred from the inputs when left out. */
  outputDir?: string;
  /** The archive's file name, `.zip` added when it lacks it; inferred from the
   *  inputs when left out (`foo.zip` gives `foo.zip.zip`, never itself). */
  outputName?: string;
  overwrite?: boolean;

  // Content
  /** The ZIP end-of-central-directory comment (UTF-8). Recorded in the manifest. */
  comment?: string;

  // Configuration
  policy?: DeepPartial<ArchivePolicy>;
}

export interface ZipKitOptions {
  policy?: DeepPartial<ArchivePolicy>;
  /** The app calling the SDK, recorded in every manifest it writes beside the
   *  SDK itself; each string at most 256 characters. */
  app?: Program;
  concurrency?: number;
  /**
   * Whether `debug` events reach `onEvent`. Off by
   * default: they are a developer's firehose, not an end user's record.
   */
  debug?: boolean;
  /**
   * The chunk size, in bytes, for all streamed I/O — the `highWaterMark` of the
   * read/inflate/deflate/write streams. A runtime/performance concern, not a
   * policy: it changes only how the work is buffered, never the archive's bytes.
   * Peak memory is roughly this times `concurrency`. Defaults to 65536 (64 KB).
   */
  chunkSize?: number;
  /**
   * The inactivity budget, in milliseconds, for each filesystem operation a
   * verb performs: one stat, directory listing, open, chunk read or write,
   * sync, or rename. An operation that has not settled within it is treated as
   * a stalled volume (a dropped network share, a removed drive): the verb stops
   * waiting and fails with a `io.stalled` error naming the operation and the path.
   * It bounds each operation, not the whole verb, so a large archive on a
   * healthy volume is never cut short. Defaults to 30000 (30 s).
   */
  ioTimeoutMs?: number;
}

/**
 * Per-call control and observation, the one set every method accepts; a key
 * outside it is refused as `options.invalid`. What a method is asked to do is
 * in its arguments, never here. Every member is per-call rather than
 * per-instance, so each call decides where its events and progress go and
 * which cancellation it answers to. None of the hooks can break the call.
 */
export interface ZipKitCallOptions {
  /** The cancellation signal. Every method honors it, stopping cleanly at the
   *  next boundary (a phase edge, a walked entry, a streamed chunk) and
   *  rejecting with the `operation.cancelled` error. */
  signal?: AbortSignal;
  /** The event hook: the one destination of the live event stream. The SDK
   *  keeps no log of its own and writes nothing to stdout or stderr, so a
   *  caller that wants a record writes these events where it keeps its own.
   *  The first call that listens also receives the instance's `session.start`. */
  onEvent?: (event: LogEvent) => void;
  /** How far `write`/`create`, `verify` and `checkRemoval` have got, for a
   *  progress bar, as counts rather than events: at the start, at most every
   *  100 ms while entries stream, and once at the end of a run that finishes.
   *  The other methods report none. */
  onProgress?: (counts: ProgressCounts) => void;
  /** Delivered after the call's logical outcome: the promise joins raw I/O
   *  and late cleanup that may outlive a cancelled or timed-out wait. Callers
   *  reserving output paths retain them until it settles. */
  onPhysicalSettlement?: (settlement: Promise<void>) => void;
}

/** How far a write or a read has got. A write counts the entries it streams
 *  and their content as on disk (the plan's `summary.sourceBytes`); a
 *  verification counts every entry and its uncompressed bytes; the removal
 *  check's recheck counts the originals' files and links and their bytes. */
export interface ProgressCounts {
  stage: "write" | "verify" | "recheck";
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

// ---------------------------------------------------------------------------
// Findings and plan
// ---------------------------------------------------------------------------

/** The rules a plan reports, in pipeline order; each one's severity and
 *  default disposition are in the registry (`RULE_REGISTRY`). */
export type RuleId =
  | "path.absolute"
  | "path.traversal"
  | "path.too-long"
  | "exclude.pattern"
  | "entry.symlink-ignored"
  | "entry.symlink-preserved"
  | "entry.unsupported"
  | "entry.unlisted"
  | "name.nfd"
  | "name.invalid-char"
  | "name.control-char"
  | "name.trailing-dot-space"
  | "name.reserved"
  | "name.suspicious"
  | "entry.duplicate"
  | "collision.case"
  | "collision.post-fix"
  | "time.pre-1980"
  | "time.post-2107"
  | "output.exists"
  | "output.busy";

/** The findings verification reports: an entry that fails its CRC-32, whose
 *  data cannot be read, whose local header disagrees with the central
 *  directory, or that fails its manifest hash or record, and entries missing
 *  from or extra to the archive against its manifest. */
export type VerifyRuleId =
  | "verify.crc32-mismatch"
  | "verify.unreadable"
  | "verify.local-mismatch"
  | "verify.sha256-mismatch"
  | "verify.manifest-mismatch"
  | "verify.missing"
  | "verify.extra";

/** Every rule a finding can carry. */
export type FindingRule = RuleId | VerifyRuleId;

/** What is at a path now: there, with a fingerprint that changes with its
 *  content and tells one file from another (`sameFile`); missing; or out of
 *  reach, on a drive that is not connected or a path that cannot be read —
 *  never taken for missing. */
export type PathState =
  | { kind: "present"; fingerprint: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** What a path is on disk: a folder, a file, something else (a socket, a
 *  device, a link whose target is gone), missing, or out of reach. */
export type PathKind = "directory" | "file" | "other" | "missing" | "unavailable";

/** A path and what it is on disk. */
export interface PathEntry {
  path: string;
  kind: PathKind;
}

/**
 * Why an entry was left out of the archive, as a stable code an app can key on;
 * `excludeReason` beside it is the same in English words, which may change.
 *
 * - `pattern`: one of the policy's exclusion patterns (its finding names it);
 * - `empty-dir` / `empty-file`: pruned or skipped as empty, by policy;
 * - `duplicate`: the same source reached through more than one input;
 * - `path-traversal`: its path would point outside the archive;
 * - `symlink`: a symbolic link, ignored by policy;
 * - `unsupported`: a socket, pipe, device or link that cannot be followed;
 *   which of these is its {@link UnsupportedKind}.
 */
export const EXCLUDE_CODES = ["pattern", "empty-dir", "empty-file", "duplicate", "path-traversal", "symlink", "unsupported"] as const;
export type ExcludeCode = (typeof EXCLUDE_CODES)[number];

/** What an `unsupported` item is: ZIP stores only files, folders and links,
 *  and under `follow` a link must lead to one of those inside the inputs
 *  (`external-link` unless `followExternal`), exist (`broken-link`) and be
 *  readable (`unreadable-link`). */
export const UNSUPPORTED_KINDS = ["socket", "fifo", "device", "broken-link", "external-link", "unreadable-link"] as const;
export type UnsupportedKind = (typeof UNSUPPORTED_KINDS)[number];

/** What a planned entry is in the archive: a preserved link is stored as a file. */
export const PLANNED_TYPES = ["file", "dir"] as const;
/** What an entry is as written and recorded, a preserved link included. */
export const ENTRY_TYPES = [...PLANNED_TYPES, "symlink"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
/** How an entry's data is stored. */
export const METHODS = ["store", "deflate"] as const;
/** What a finding's fix does. */
export const FIX_KINDS = ["rename", "exclude", "normalize-attrs"] as const;

export interface Finding {
  /** Stable across runs: the same finding on a fresh plan of the same tree
   *  has the same id, whatever its message says, so a caller compares plans
   *  by it. */
  id: string; // identity
  /** What was found: a plan rule (`RuleId`) or, from verification, a
   *  `VerifyRuleId`. Both are listed in the registry and stable. */
  rule: FindingRule;
  severity: Severity; // classification (sourced from the registry)
  path: string; // locator
  message: string;
  fix?: { kind: (typeof FIX_KINDS)[number]; to?: string };
}

export interface PlannedEntry {
  archivePath: string; // identity (final, forward-slash, relative; NFC when the nfc policy is "fix")
  originalPath: string; // identity (as found on disk, pre-fix)
  /** Where the item is on disk: the input as given joined with the item's
   *  path inside it, through any followed link, so it names the place the
   *  user sees rather than a link's target. Absolute. */
  diskPath: string;
  type: (typeof PLANNED_TYPES)[number]; // classification
  method: (typeof METHODS)[number];
  excluded: boolean; // state
  /** Why it was left out, as a stable code; present exactly when `excluded`. */
  excludeCode?: ExcludeCode;
  /** The same, in English words that may change: for display, never to key on. */
  excludeReason?: string;
  /** What it is, present exactly when `excludeCode` is `unsupported`. */
  unsupportedKind?: UnsupportedKind;
  /** The pattern that left it out, present exactly when `excludeCode` is `pattern`. */
  excludedBy?: ExcludedBy;
  /** The name rules that renamed this entry's own name, or a folder above it
   *  that has no entry of its own; empty when nothing of its own was renamed. */
  nameFixes: NameFix[];
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
  /** The size of what is archived, as on disk: every included file's bytes
   *  and every stored link's target. Compared with the archive's size, the
   *  compression ratio. */
  sourceBytes: number;
}

/**
 * What `plan()` returns, and what `create()` returns when the plan blocks (such
 * as on an existing output without `overwrite`). `mode` tells it from
 * {@link WriteData}, so neither shape carries a field it cannot honestly fill:
 * a plan reads and hashes nothing, and its `entries` are the pre-write view (no
 * CRC or SHA-256).
 *
 * A plan is plain data: a structured clone or a JSON round trip of it is
 * still writable, so an app can plan in one process and write in another.
 */
export interface PlanData {
  mode: "plan"; // planned, nothing written
  output: string; // resolved output path (the intended target)
  writable: boolean; // the gate
  summary: PlanSummary;
  findings: Finding[]; // SSOT
  entries: PlannedEntry[]; // pre-write view (no crc/sha)
  /** What `write` reads and how; see {@link PlanInstructions}. */
  instructions: PlanInstructions;
}

/**
 * What `write()` returns, and `create()` when it writes: post-write truth. The
 * per-entry record (CRC, SHA-256, sizes) is held once, in `manifest.entries`.
 * Both verbs throw only on an operational fault.
 */
export interface WriteData {
  mode: "write"; // actual create
  output: string;
  bytes: number; // final on-disk size
  zip64: boolean;
  summary: PlanSummary;
  findings: Finding[]; // SSOT (domain + operational)
  /** The manifest document: the post-write per-entry record (CRC, SHA-256,
   *  sizes, times), embedded unless the policy turned the manifest off. */
  manifest: Manifest;
}

/**
 * The writer's instructions a plan carries: the output, whether the plan may
 * be written, whether it needs Zip64, the resolved policy, whether an existing
 * output may be replaced, the zone the DOS times are rendered in, the archive
 * comment, and every included entry with the absolute path it is read from and
 * its times as decimal nanosecond strings. `write` acts on these alone; they
 * are not for the caller to change. It refuses instructions of the wrong shape,
 * and a plan whose visible entries, findings or summary disagree with them,
 * as `plan.invalid`. They hold absolute source paths, so a plan is for crossing
 * between an app's own processes, never for sending off the machine.
 */
export interface PlanInstructions {
  output: string;
  writable: boolean;
  zip64: boolean;
  policy: ArchivePolicy;
  overwrite: boolean;
  timeZone: string;
  comment?: string;
  entries: InstructionEntry[];
}

/** One included entry in {@link PlanInstructions}. */
export interface InstructionEntry {
  archivePath: string;
  originalPath: string;
  sourcePath: string;
  type: EntryType;
  method: (typeof METHODS)[number];
  /** Where it is read from; empty for a folder entry the plan adds. */
  absolutePath: string;
  size: number;
  mtimeNs: string;
  atimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  mode: number;
  linkTarget?: string;
  nameFixes: NameFix[];
}


export type { ErrorDiagnostic, ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, ZipKitErrorData } from "./errors.ts";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** A UTC instant as both its lossless nanosecond count and an ISO-8601 string. */
export interface UtcTime {
  ns: string;
  iso: string;
}

/** One name fix applied to an entry. `rule` is a `RuleId`. */
export interface NameFix {
  rule: RuleId;
  before: string;
  after: string;
}

/** One written entry's record in the {@link Manifest} document. */
export interface ManifestEntry {
  archivePath: string; // identity
  originalPath: string;
  sourcePath: string;
  type: EntryType; // classification
  method: (typeof METHODS)[number];
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
  nameFixes: NameFix[]; // nested detail
}

/** A dropped entry's record in the {@link Manifest} document. */
export interface ManifestExcluded {
  archivePath: string;
  originalPath: string;
  type: EntryType;
  /** Why it was left out, as a stable code. */
  excludeCode: ExcludeCode;
  /** The same in English words, which may change. */
  reason?: string;
  /** What it is, when `excludeCode` is `unsupported`. */
  unsupportedKind?: UnsupportedKind;
  /** The pattern that left it out, when `excludeCode` is `pattern`. */
  excludedBy?: ExcludedBy;
}

/** The policy as a manifest records it: the resolved policy without what
 *  only describes it (exclusion notes) or is recorded once elsewhere (the
 *  time zone, the manifest's own `timeZone`). */
export type RecordedPolicy = Omit<ArchivePolicy, "timeZone" | "exclusions"> & {
  exclusions: Omit<ExclusionPattern, "note">[];
};

/** The program a manifest names: the SDK that wrote it, or the app that
 *  called the SDK. */
export interface Program {
  name: string;
  version?: string;
}

/** A file entry singled out for its modification time — the oldest or newest in
 *  the set. Carries the entry's archive path and its UTC modification time. */
export interface ExtremeEntry {
  archivePath: string;
  mtime: UtcTime;
}

/**
 * The lossless structured record of an archive run: header, per-entry records,
 * dropped entries, and findings. Returned from every `write` and `create` and embedded as
 * `zipkit.json` unless disabled.
 */
export interface Manifest {
  /** A plain-language sentence saying what the document is, for a recipient
   *  who opens it without knowing ZipKit. */
  about: string; // identity
  /** The SDK that wrote it: `zipkitsdk` with its version and repository. */
  writer: Program & { version: string; repository: string }; // provenance
  /** The app that called the SDK, when the caller named it (`ZipKitOptions.app`). */
  app?: Program;
  createdAtUtc: UtcTime;
  /** What kind of document this is, beside its version: always `zipkit.manifest`. */
  format: "zipkit.manifest";
  /** The document's layout version; raised when a reader must tell layouts apart. */
  formatVersion: number;
  /** The IANA zone the DOS local-time fields were rendered in. */
  timeZone: string;
  /** The archive comment, present only when one was set. */
  comment?: string;
  policy: RecordedPolicy; // configuration
  /** Quantities (aggregate); `sourceBytes` is absent from archives made
   *  before ZipKit recorded it. */
  summary: Omit<PlanSummary, "sourceBytes"> & { sourceBytes?: number };
  totals: { uncompressedBytes: number; compressedBytes: number };
  /**
   * The modification-time span of the archived file set: the oldest and newest
   * file entries by `mtime` (UTC). Computed over file and symlink entries, never
   * synthetic directories. `null` when the set has no such entry (e.g. an archive
   * of only empty directories), so a caller reads the range without scanning
   * {@link Manifest.entries} or parsing nanosecond strings.
   */
  timeRange: { oldest: ExtremeEntry; newest: ExtremeEntry } | null;
  entries: ManifestEntry[]; // nested detail
  excluded: ManifestExcluded[];
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/** What `ZipKit.verify` checks. */
export interface VerifyRequest {
  /** The archive's absolute path. */
  archive: string;
  /** Also hold the archive to its embedded manifest: every recorded entry
   *  present, nothing extra, and each type, size, CRC-32 and recorded SHA-256
   *  equal. Without it the check is the archive's own integrity and works on
   *  any ZIP. */
  manifest?: boolean;
  /** The manifest's name, when the archive was made with another than the
   *  instance policy's. */
  manifestName?: string;
}

/** One entry's verification. */
export interface VerifiedEntry {
  archivePath: string; // identity
  type: EntryType; // classification
  /** Its data against its CRC-32, or `unreadable` when the data could not be
   *  decompressed (an unsupported method, a broken stream, a wrong size). */
  crc32: "ok" | "fail" | "unreadable"; // outcome
  /** Its content against the manifest's SHA-256, under `manifest` only;
   *  `absent` when the manifest recorded none. */
  sha256?: "ok" | "mismatch" | "absent";
}

/**
 * The `verify` verb's payload. `findings` holds each failure; `ok` is the
 * verdict: every entry readable with its CRC-32 and local header intact, and
 * under `manifest` nothing missing or extra and no SHA-256, size or CRC-32
 * differing from the manifest. A run can complete yet not be ok, so a caller
 * decides from `ok`, as the removal check does.
 */
export interface VerifyData {
  archive: string; // identity
  ok: boolean; // verdict
  /** The embedded manifest used, under `manifest`. */
  manifest: { name: string } | null;
  summary: {
    total: number;
    crc32Failed: number;
    /** Entries whose data could not be read. */
    unreadable: number;
    /** Entries whose local header disagrees with the central directory. */
    localMismatched: number;
    /** Entries whose content differs from the manifest's SHA-256 (`manifest`). */
    sha256Mismatched: number;
    /** Entries whose type, size or CRC-32 differs from the manifest (`manifest`). */
    manifestMismatched: number;
  };
  entries: VerifiedEntry[];
  /** In the manifest but absent from the archive (`manifest`). */
  missing: string[];
  /** In the archive but absent from the manifest (`manifest`). */
  extra: string[];
  findings: Finding[]; // SSOT
}

/**
 * How an archive's inputs on disk compare with its manifest, as the removal
 * check's `changed` refusal carries it. Each list names absolute places on
 * disk: where an item is now, or for one only the manifest records, where it
 * was. `matches` is the delete gate: true only when every included file and
 * symlink is as archived, by content too, and the fresh scan listed every
 * folder.
 */
export interface SourceComparison {
  matches: boolean;
  /** Included now but not in the manifest. */
  added: string[];
  /** In the manifest but no longer included. */
  missing: string[];
  /** In both, with a different type, size, modification time or content. */
  changed: string[];
  /** Folders the fresh scan could not list, so their contents went unchecked. */
  unlisted: string[];
}

/** Why the originals may not be removed: the first check of
 *  `ZipKit.checkRemoval` that refused. */
export type RemovalRefusal =
  /** The archive sits at or inside an input, so removing it would take the archive along. */
  | { reason: "inside" }
  /** The archive does not verify against its manifest: what failed. */
  | { reason: "verify-failed"; report: VerifyReport }
  /** The inputs no longer match what the archive holds. */
  | { reason: "changed"; comparison: SourceComparison }
  /** A check could not finish, such as on a stalled drive: the error it
   *  ended with, and which check it was. A cancellation is thrown instead. */
  | { reason: "error"; step: "location" | "verify" | "recheck"; error: ZipKitErrorData };

/** What a verification found, without every entry's result. */
export interface VerifyReport {
  summary: VerifyData["summary"];
  /** In the manifest but absent from the archive. */
  missing: string[];
  /** In the archive but absent from the manifest. */
  extra: string[];
  findings: Finding[];
}

/** The answer of `ZipKit.checkRemoval`. */
export interface RemovalCheck {
  /** Null when removing the originals cannot lose data. */
  refusal: RemovalRefusal | null;
  /** Set once the archive verified, even if a later check refused: the
   *  fingerprint of the file that verified, null when its state could not be
   *  read. Null when it did not verify. */
  verified: { fingerprint: string | null } | null;
}

/** What `ZipKit.checkRemoval` checks. */
export interface RemovalRequest {
  /** The spec the archive was created with, its inputs only those still to be
   *  removed, so the same entries are included and excluded. */
  spec: ArchiveSpec;
  /** The archive's absolute path. */
  archive: string;
  /** Inputs of the spec that were already removed, such as by an earlier
   *  partial removal: what the archive holds from them is not counted as
   *  missing, and only the rest are checked. */
  removed?: readonly string[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The phase a {@link LogEvent} belongs to. `session` carries the once-per-session
 *  startup line; the rest are the verb pipeline phases. */
export type LogStage = "session" | "scan" | "plan" | "write" | "verify";

/** The severity of a {@link LogEvent}. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The typed body of a {@link LogEvent}, a discriminated union on `event`. Each
 * variant carries exactly the fields it means — there is no untyped `data` bag,
 * so the SDK and the `onEvent` hook agree on each event's shape by the type
 * system, not by string convention.
 */
export type LogEventBody =
  | {
      event: "session.start";
      version: string;
      concurrency: number;
      chunkSize: number;
      ioTimeoutMs: number;
      debug: boolean;
      /** The instance policy, resolved: what every call starts from. */
      policy: ArchivePolicy;
    }
  | { event: "scan.start"; inputs: number }
  | { event: "scan.dir"; path: string }
  | { event: "scan.symlink-unreadable"; path: string }
  | { event: "scan.done"; entries: number; prunedDirs: number }
  | {
      event: "plan.done";
      total: number;
      included: number;
      excluded: number;
      renamed: number;
      warnings: number;
      errors: number;
      writable: boolean;
    }
  | { event: "entry.excluded"; path: string; reason?: string }
  | { event: "entry.renamed"; path: string; from: string }
  | { event: "entry.flagged"; rule: FindingRule; path: string; severity: Severity; reason?: string }
  | { event: "write.start"; entries: number }
  | { event: "entry.written"; path: string }
  | { event: "write.done"; bytes: number; zip64: boolean }
  | { event: "verify.start"; entries: number }
  | { event: "entry.verified"; path: string }
  | ({ event: "verify.done"; ok: boolean } & VerifyData["summary"])
  /** A call failed: its error and originating diagnostic chain, serialized.
   *  A cancellation is recorded at `info`. */
  | { event: "fault"; error: ZipKitErrorData };

/**
 * The common classification every event carries. `stage` is an additional field
 * beyond the convention's fixed envelope; `level` is part of it. `time` and
 * `message` — the rest of the envelope — are stamped by the logger, not the
 * producer, so they are not on this body.
 */
export interface LogMeta {
  stage: LogStage;
  level: LogLevel;
}

/**
 * A single structured event in the one log/progress stream. The logger stamps
 * the convention envelope onto each emitted body: `time` (UTC ISO-8601 with
 * milliseconds and `Z`) and a short, stable, human-readable `message` derived
 * from the typed `event`. `stage` and the discriminated `event` fields ride
 * alongside as additional fields.
 */
export type LogEvent = { time: string; message: string } & LogMeta & LogEventBody;
