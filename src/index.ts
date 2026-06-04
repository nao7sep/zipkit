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
  ExtractEntryResult,
  ExtractReport,
  ExtractSpec,
  Finding,
  FilterRule,
  LogEvent,
  MetadataPolicy,
  Plan,
  PlanSummary,
  PlannedEntry,
  Severity,
  WriteResult,
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
