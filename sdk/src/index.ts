/**
 * The committed public surface. The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.ts";
export type { PlanData, WriteData } from "./zipkit.ts";
export { exportPlan, importPlan } from "./transfer.ts";
export { sameFile } from "./paths.ts";
export { createPathClaims } from "./claims.ts";
export { unarchived } from "./removal.ts";
export type { PathClaim, PathClaims, PathResource, PathUse } from "./claims.ts";
export { machineTimeZone } from "./internal/timeZone.ts";
export type { PlanTransfer } from "./transfer.ts";

export { RULE_REGISTRY } from "./registry.ts";
export type { ExtractRuleId, FindingRule, RuleId, RuleSpec } from "./registry.ts";

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
  VerifyReport,
  Severity,
  SourceComparison,
  Transformation,
  Unarchived,
  UtcTime,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.ts";

export { ERROR_CODES, isZipKitError, ZipKitError } from "./errors.ts";
export type { ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, ZipKitErrorData } from "./errors.ts";

export type { Volume, VolumeFile } from "./internal/volume.ts";
