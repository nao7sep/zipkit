/**
 * The committed public surface. The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.ts";
export type { PlanData, WriteData } from "./zipkit.ts";
export { sameFile } from "./paths.ts";

export { RULE_REGISTRY } from "./registry.ts";
export { DEFAULT_EXCLUSIONS } from "./filter/defaults.ts";
export { DEFAULT_POLICY } from "./defaults.ts";
export type { VerifyRuleId, FindingRule, RuleId, RuleSpec } from "./registry.ts";

export type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  DeepPartial,
  ExcludeCode,
  ExcludedBy,
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
  Program,
  RecordedPolicy,
  PlannedEntry,
  ProgressCounts,
  RemovalMethod,
  RemovalOutcome,
  RemovalRequest,
  RemovalRefusal,
  RemovalResult,
  VerifyReport,
  Severity,
  SourceComparison,
  UtcTime,
  VerifiedEntry,
  VerifyData,
  VerifyRequest,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.ts";

export { ERROR_CODES, errorDiagnostic, isZipKitError, ZipKitError } from "./errors.ts";
export type { ErrorDiagnostic, ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, ZipKitErrorData } from "./errors.ts";

export type { Volume, VolumeFile } from "./internal/volume.ts";
