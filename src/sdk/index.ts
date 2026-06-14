/**
 * The committed public surface. The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.js";

export type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  CreateData,
  ExtractData,
  ExtractEntryResult,
  ExtractSpec,
  ExtremeEntry,
  Finding,
  FilterRule,
  LogEvent,
  LogLevel,
  LogStage,
  Metadata,
  MetadataEntry,
  MetadataExcluded,
  MetadataPolicy,
  PlanSummary,
  PlannedEntry,
  Severity,
  Transformation,
  UtcTime,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.js";

export {
  AbortError,
  PolicyError,
  ReadError,
  ScanError,
  WriteError,
  ZipKitError,
} from "./errors.js";

export type { ZipKitErrorType } from "./errors.js";
