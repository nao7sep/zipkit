/**
 * The job's input list with add/remove (input CRUD) and drag-and-drop. A job's
 * inputs are not frozen at creation: the user can add a directory/file they forgot
 * (button or by dropping onto this list) or drop one they no longer want, without
 * rebuilding the job. Rows are ordered directories-first then files (alphabetical
 * within each group) and show the full path plus what it is on disk (directory /
 * file / missing), so a vanished input is visible. The last input cannot be
 * removed — a job must archive something. Hovering a row highlights it, so on a
 * wide window it stays clear which input the far-right remove icon will remove.
 *
 * The Inputs block itself is the receiver. It highlights locally during file
 * delivery, clears stale presentation if the native drag omits its terminal event,
 * and reports every committed non-success beside the list. The window's separate
 * denial boundary only prevents navigation outside owned receivers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import type { Job, PathKind } from "../../../shared/api";
import {
  droppedFileOperationKey,
  inspectExternalFileOffer,
  reportableError,
  type ReceiverOutcome,
  type ReceiverResult,
} from "../externalDropBoundary";
import { COLOR, orderedEntries } from "../view";
import { CloseIcon } from "./Icon";
import { ReceiverResultNotice } from "./ReceiverResultNotice";

const KIND_LABEL: Record<PathKind, string> = {
  directory: "Directory",
  file: "File",
  nonexistent: "Missing",
  other: "Other",
};

function kindColor(kind: PathKind): string {
  if (kind === "nonexistent") return COLOR.bad;
  if (kind === "other") return COLOR.warn;
  return "var(--text-2)";
}

export function InputList({
  job,
  editable,
  onAdd,
  onRemove,
  onDropFiles,
  result,
  onResult,
}: {
  job: Job;
  editable: boolean;
  onAdd: () => Promise<ReceiverOutcome | null>;
  onRemove: (path: string) => void;
  onDropFiles: (files: File[]) => Promise<ReceiverOutcome>;
  result: ReceiverResult | null;
  onResult: (outcome: ReceiverOutcome) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rows: { path: string; kind?: PathKind }[] = job.entries
    ? orderedEntries(job.entries)
    : job.inputs.map((path) => ({ path }));
  const canRemove = editable && job.inputs.length > 1;

  const clearDrag = useCallback(() => {
    if (cleanupTimer.current !== null) clearTimeout(cleanupTimer.current);
    cleanupTimer.current = null;
    setDragActive(false);
  }, []);

  const showDrag = useCallback(() => {
    if (cleanupTimer.current !== null) clearTimeout(cleanupTimer.current);
    setDragActive(true);
    cleanupTimer.current = setTimeout(clearDrag, 1_000);
  }, [clearDrag]);

  useEffect(() => {
    window.addEventListener("blur", clearDrag);
    window.addEventListener("dragend", clearDrag);
    return () => {
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("dragend", clearDrag);
      if (cleanupTimer.current !== null) clearTimeout(cleanupTimer.current);
    };
  }, [clearDrag]);

  function onDragOver(e: ReactDragEvent) {
    if (inspectExternalFileOffer(e.dataTransfer) === "rejected") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
    if (!editable) {
      clearDrag();
      return;
    }
    e.dataTransfer.dropEffect = "copy";
    showDrag();
  }

  async function onDrop(e: ReactDragEvent) {
    const offer = inspectExternalFileOffer(e.dataTransfer);
    const files = Array.from(e.dataTransfer.files);
    const entryKey = `inputs:${job.id}:drop`;
    const operationKey = files.length > 0
      ? droppedFileOperationKey(`inputs:${job.id}`, files)
      : entryKey;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
    clearDrag();
    if (offer === "rejected") {
      onResult({
        operationKey: `inputs:${job.id}:unsupported-drop`,
        entryKey,
        result: { message: "Drop files or folders to add inputs to this job.", severity: "warning" },
      });
      return;
    }
    if (!editable) {
      onResult({
        operationKey,
        entryKey,
        result: { message: "Inputs cannot be changed in the current job state.", severity: "warning" },
      });
      return;
    }
    try {
      if (files.length === 0) {
        onResult({
          operationKey,
          entryKey,
          result: {
            message: "The dropped items could not be accessed as local files or folders.",
            severity: "warning",
          },
        });
        return;
      }
      e.dataTransfer.dropEffect = "copy";
      const next = await onDropFiles(files);
      onResult(next);
    } catch (error) {
      window.zipkit.reportError("commit dropped existing-job inputs", reportableError(error));
      onResult({
        operationKey,
        entryKey,
        result: {
          message: `Could not add the dropped inputs: ${errorMessage(error)}`,
          severity: "error",
        },
      });
    }
  }

  async function onAddClick() {
    try {
      const next = await onAdd();
      if (next) onResult(next);
    } catch (error) {
      window.zipkit.reportError("choose existing-job inputs", reportableError(error));
      onResult({
        operationKey: `inputs:${job.id}:picker`,
        entryKey: `inputs:${job.id}:picker`,
        result: { message: `Could not add inputs: ${errorMessage(error)}`, severity: "error" },
      });
    }
  }

  return (
    <div
      data-drop-receiver="inputs"
      style={{ ...S.zone, ...(dragActive ? S.zoneActive : null) }}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) clearDrag();
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <div style={S.head}>
        <span style={S.title}>Inputs</span>
        <button onClick={() => void onAddClick()} disabled={!editable}>
          Add
        </button>
      </div>
      <ul style={S.list}>
        {rows.map(({ path, kind }) => (
          <li key={path} className="input-row" style={S.row}>
            {kind && <span style={{ ...S.kind, color: kindColor(kind) }}>{KIND_LABEL[kind]}</span>}
            <span style={S.path} title={path}>
              {path}
            </span>
            <button
              className="icon"
              onClick={() => onRemove(path)}
              disabled={!canRemove}
              title={canRemove ? "Remove from this job" : "A job needs at least one input"}
              aria-label={`Remove ${path}`}
            >
              <CloseIcon />
            </button>
          </li>
        ))}
      </ul>
      {result && (
        <ReceiverResultNotice
          result={result}
          onDismiss={() => onResult({
            operationKey: result.operationKey,
            entryKey: result.operationKey,
            result: null,
          })}
        />
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const S: Record<string, CSSProperties> = {
  zone: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "0.6rem",
    margin: "0 0 0.75rem",
  },
  zoneActive: {
    boxShadow: "inset 0 0 0 2px var(--accent)",
    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    marginBottom: "0.5rem",
  },
  title: { fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-2)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.1rem" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    minWidth: 0,
    padding: "0.2rem 0.4rem",
    borderRadius: 5,
  },
  kind: { fontSize: "0.7rem", fontWeight: 700, flexShrink: 0, width: "4.2rem" },
  // Full path, wrapping rather than truncating — in a management list, seeing the
  // whole path matters more than a tidy single line.
  path: { flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: "0.85rem" },
};
