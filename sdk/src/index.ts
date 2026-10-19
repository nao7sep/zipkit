/**
 * The committed public surface. The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.ts";
export type { PlanData, WriteData } from "./zipkit.ts";
export { sameFile } from "./paths.ts";
export { createPathClaims } from "./claims.ts";
export type { PathClaim, PathClaims, PathResource, PathUse } from "./claims.ts";

export { RULE_REGISTRY } from "./registry.ts";
export { DEFAULT_EXCLUSIONS } from "./filter/defaults.ts";
export type { VerifyRuleId, FindingRule, RuleId, RuleSpec } from "./registry.ts";

export type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  DeepPartial,
  ExcludeCode,
  UnsupportedKind,
  ExtremeEntry,
  Finding,
  ExclusionPattern,
  InstructionEntry,
  InvalidCharStyle,
  NameAction,
  NameFix,
  NameRules,
  PathEntry,
  PathKind,
  PathState,
  LogEvent,
  LogEventBody,
  LogMeta,
  LogLevel,
  LogStage,
  Manifest,
  ManifestEntry,
  ManifestExcluded,
  ManifestPolicy,
  PlanInstructions,
  PlanSummary,
  PlannedEntry,
  ProgressCounts,
  RemovalCheck,
  RemovalOptions,
  RemovalRefusal,
  VerifyReport,
  Severity,
  SourceComparison,
  UtcTime,
  VerifiedEntry,
  VerifyData,
  VerifyOptions,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.ts";

export { ERROR_CODES, isZipKitError, ZipKitError } from "./errors.ts";
export type { ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, ZipKitErrorData } from "./errors.ts";

export type { Volume, VolumeFile } from "./internal/volume.ts";
