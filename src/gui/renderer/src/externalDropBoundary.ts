import type { GuiReportedError } from "../../shared/api";
import { isEditableTarget } from "./shortcuts";

export type ExternalFileOffer = "rejected" | "delivery-only";

/** During a native drag the renderer can usually prove only that the offer contains
 * files. Host paths remain protected until drop, so acceptance stays neutral. */
export function inspectExternalFileOffer(
  dataTransfer: Pick<DataTransfer, "types" | "items">,
): ExternalFileOffer {
  const items = Array.from(dataTransfer.items);
  const hasFiles = Array.from(dataTransfer.types).includes("Files") ||
    items.some((item) => item.kind === "file");
  return hasFiles ? "delivery-only" : "rejected";
}

export interface ResolvedDroppedFiles {
  paths: string[];
  duplicates: number;
  unavailable: number;
  errors: GuiReportedError[];
}

export interface ReceiverCommit {
  changed: boolean;
  accepted: number;
  result: ReceiverResultDetails | null;
}

export type ReceiverResultSeverity = "information" | "warning" | "error";

export interface ReceiverResultDetails {
  message: string;
  severity: ReceiverResultSeverity;
}

export interface ReceiverResult extends ReceiverResultDetails {
  operationKey: string;
}

export interface ReceiverOutcome {
  operationKey: string;
  entryKey: string;
  result: ReceiverResultDetails | null;
}

export function receiverOperationKey(receiver: string, paths: Iterable<string>): string {
  return JSON.stringify([receiver, [...new Set(paths)].sort()]);
}

/** Stable even when Electron cannot resolve a File to a host path. The platform
 * exposes no directory identity before that boundary, so name/size/time/type are
 * the narrowest retry identity available without conflating every drop. */
export function droppedFileOperationKey(
  receiver: string,
  files: Iterable<File> | ArrayLike<File>,
): string {
  const identities = [...new Set(Array.from(files)
    .map((file) => JSON.stringify([file.name, file.size, file.lastModified, file.type])))]
    .sort();
  return JSON.stringify([receiver, identities]);
}

/** A later non-success supersedes the visible result. A quiet success clears only
 * the result owned by that exact receiver operation; unrelated feedback remains. */
export function settleReceiverResult(
  current: ReceiverResult | null,
  outcome: ReceiverOutcome,
): ReceiverResult | null {
  if (outcome.result !== null) return { ...outcome.result, operationKey: outcome.operationKey };
  return current?.operationKey === outcome.operationKey ||
    current?.operationKey === outcome.entryKey
    ? null
    : current;
}

export function reportableError(error: unknown): GuiReportedError {
  if (!(error instanceof Error)) return { name: "NonError", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause !== undefined ? { cause: reportableError(error.cause) } : {}),
  };
}

/** Resolve the host-authoritative local paths at drop time. One inaccessible or
 * synthetic File is accounted for without discarding the usable members. */
export function resolveDroppedFiles(
  files: Iterable<File> | ArrayLike<File>,
  pathForFile: (file: File) => string,
): ResolvedDroppedFiles {
  const paths = new Set<string>();
  let duplicates = 0;
  let unavailable = 0;
  const errors: GuiReportedError[] = [];
  for (const file of Array.from(files)) {
    try {
      const path = pathForFile(file);
      if (!path) {
        unavailable++;
      } else if (paths.has(path)) {
        duplicates++;
      } else {
        paths.add(path);
      }
    } catch (error) {
      unavailable++;
      errors.push(reportableError(error));
    }
  }
  return { paths: [...paths], duplicates, unavailable, errors };
}

/** Build the single receiver-local result for a committed external drop. A clean
 * full success remains quiet; any partial resolution accounts for every omitted
 * item alongside the durable operation's own result. */
export function summarizeDroppedFiles(
  successLead: string,
  resolved: ResolvedDroppedFiles,
  commit: ReceiverCommit,
): ReceiverResultDetails | null {
  const details: string[] = [];
  const severities: ReceiverResultSeverity[] = [];
  if (commit.result) {
    details.push(commit.result.message);
    severities.push(commit.result.severity);
  }
  if (resolved.duplicates > 0) {
    details.push(
      `${resolved.duplicates} ${resolved.duplicates === 1 ? "dropped item repeated" : "dropped items repeated"} the same local path.`,
    );
    severities.push("information");
  }
  if (resolved.unavailable > 0) {
    details.push(
      `${resolved.unavailable} ${resolved.unavailable === 1 ? "dropped item was" : "dropped items were"} not available as a local path.`,
    );
    severities.push(resolved.errors.length > 0 ? "error" : "warning");
  }
  if (details.length === 0) return null;
  if (commit.changed && !commit.result) {
    details.unshift(`${successLead} ${commit.accepted} ${commit.accepted === 1 ? "input" : "inputs"}.`);
  }
  return {
    message: details.join(" "),
    severity: highestSeverity(severities),
  };
}

function highestSeverity(severities: ReceiverResultSeverity[]): ReceiverResultSeverity {
  if (severities.includes("error")) return "error";
  if (severities.includes("warning")) return "warning";
  return "information";
}

/** Refuse every unowned desktop-webview drop while retaining native non-file
 * text/link editing. Owned input targets prevent the event before this boundary. */
export function denyUnhandledExternalDrop(event: DragEvent): void {
  if (event.defaultPrevented) return;
  const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes("Files") ||
    Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file");
  if (!hasFiles && isEditableTarget(event.target)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
}
