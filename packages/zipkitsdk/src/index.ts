/**
 * The committed public surface. The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.js";
export type { PlanData, WriteData } from "./zipkit.js";
export { exportPlan, importPlan } from "./transfer.js";
export { sameFile } from "./paths.js";
export { createPathClaims } from "./claims.js";
export { unarchived } from "./removal.js";
export type { PathClaim, PathClaims, PathResource, PathUse } from "./claims.js";
export { machineTimeZone } from "./internal/timeZone.js";
export type { PlanTransfer } from "./transfer.js";

export { RULE_REGISTRY } from "./registry.js";
export type { ExtractRuleId, FindingRule, RuleId, RuleSpec } from "./registry.js";

export type {
  ArchiveInput,
  ArchiveListing,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  CreateData,
  DeepPartial,
  ExcludeCode,
  ExtractData,
  ExtractEntryResult,
  ExtractSpec,
  ExtremeEntry,
  Finding,
  FilterRule,
  InvalidCharStyle,
  NameAction,
  NameRules,
  PathEntry,
  PathKind,
  PathState,
  LogEvent,
  LogEventBody,
  LogMeta,
  LogLevel,
  ListedEntry,
  LogStage,
  Metadata,
  MetadataEntry,
  MetadataExcluded,
  MetadataPolicy,
  PlanSummary,
  PlannedEntry,
  ProgressCounts,
  RemovalCheck,
  RemovalOptions,
  RemovalRefusal,
  Severity,
  SourceComparison,
  Transformation,
  Unarchived,
  UtcTime,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.js";

export {
  AbortError,
  PolicyError,
  ReadError,
  ScanError,
  StallError,
  WriteError,
  ZipKitError,
} from "./errors.js";

export type { ZipKitErrorType } from "./errors.js";

export type { Volume, VolumeFile } from "./internal/volume.js";
