/**
 * The committed public surface (§6). The scan layer, the rule passes, and the
 * writer are internal and may be refactored without affecting this surface.
 */

export { ZipKit } from "./zipkit.js";

export type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
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
  ScanError,
  WriteError,
  ZipKitError,
} from "./errors.js";

export type { ZipKitErrorType } from "./errors.js";
