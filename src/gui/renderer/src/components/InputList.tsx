/**
 * The job's input list with add/remove (input CRUD) and drag-and-drop. A job's
 * inputs are not frozen at creation: the user can add a directory/file they forgot
 * (button or by dropping onto this list) or drop one they no longer want, without
 * rebuilding the job. Rows are ordered directories-first then files (alphabetical
 * within each group) and show the full path plus what it is on disk (directory /
 * file / missing), so a vanished input is visible. The last input cannot be
 * removed — a job must archive something. Hovering a row highlights it, so on a
 * wide window it stays clear which input the far-right ✕ will remove.
 *
 * The drop area is marked by a permanent, plain border — NOT a drag-state
 * highlight. A highlight driven by drag events can get stuck (an external drag
 * cancelled over the window fires no drop/leave/dragend in the renderer), so there
 * is no drag state to strand: the border is always there, the OS shows the copy
 * cursor while dragging, and the list updating is the drop's confirmation. The
 * window blocks accidental file-to-page navigation globally (see App). Processing a
 * drop is wrapped so an unsupported item can't throw out of the handler.
 */

import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import type { Job, PathKind } from "../../../shared/api";
import { COLOR, orderedEntries } from "../view";

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
}: {
  job: Job;
  editable: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
  onDropFiles: (files: File[]) => void;
}) {
  const rows: { path: string; kind?: PathKind }[] = job.entries
    ? orderedEntries(job.entries)
    : job.inputs.map((path) => ({ path }));
  const canRemove = editable && job.inputs.length > 1;

  function onDragOver(e: ReactDragEvent) {
    if (!editable) return;
    e.preventDefault(); // required for the drop to fire
    e.dataTransfer.dropEffect = "copy";
  }
  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    if (!editable) return;
    try {
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onDropFiles(files);
    } catch {
      // An unsupported item must never throw out of the handler.
    }
  }

  return (
    <div style={S.zone} onDragOver={onDragOver} onDrop={onDrop}>
      <div style={S.head}>
        <span style={S.title}>Inputs</span>
        <button onClick={onAdd} disabled={!editable}>
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
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  // The whole inputs block is the drop zone, marked by a permanent, plain border
  // (no drag-state highlight that could get stuck). An inset box with comfortable
  // padding so it reads as "the inputs / drop here" area.
  zone: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "0.6rem",
    margin: "0 0 0.75rem",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    marginBottom: "0.5rem",
  },
  title: { fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-2)" },
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
