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

export interface FilterRule {
  action: "include" | "exclude";
  pattern: string;
  /** Pattern dialect. Defaults to `"glob"`. */
  match: "glob" | "regex" | "literal";
  /** Which entry kinds the rule applies to. Defaults to `"both"`. */
  target: "file" | "dir" | "both";
}

export interface CompressionPolicy {
  mode: "auto" | "store-all" | "compress-all";
  /** Lowercase extensions (with leading dot) stored verbatim under `"auto"`. */
  storeExtensions: string[];
}

export interface MetadataPolicy {
  name: string;
  placement: "inside" | "sidecar";
  /** Compute a SHA-256 per file in addition to the always-present CRC-32. */
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
  timestamps: "clamp" | "preserve";
  compression: CompressionPolicy;

  // Companion output
  metadata: false | MetadataPolicy;

  // Container format
  zip64: "auto" | "never" | "always";
  deterministic: boolean;

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
  plan: Plan; // nested detail
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface LogEvent {
  ts: string; // time of emission, ISO 8601 UTC
  stage: "scan" | "plan" | "write"; // classification
  level: "debug" | "info" | "warn" | "error";
  message: string;
  rule?: string; // context
  path?: string;
  data?: Record<string, unknown>; // payload
}
