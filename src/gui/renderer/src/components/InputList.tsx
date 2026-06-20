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
 * Drag tracking uses an enter/leave depth counter (so moving over child rows does
 * not flicker the highlight off) and force-resets on drop and on any window-level
 * drop/dragend — a bad drop (e.g. an unsupported item) can never strand the
 * highlight on. Processing a drop is wrapped so a throw can't strand it either.
 */

import { useEffect, useRef, useState } from "react";
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
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  const rows: { path: string; kind?: PathKind }[] = job.entries
    ? orderedEntries(job.entries)
    : job.inputs.map((path) => ({ path }));
  const canRemove = editable && job.inputs.length > 1;

  // Backstop: any drop or drag-end anywhere ends the gesture, so the highlight
  // can never get stuck on if our own drop/leave events don't fire.
  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDragOver(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  function onDragEnter(e: ReactDragEvent) {
    if (!editable) return;
    e.preventDefault();
    depth.current += 1;
    setDragOver(true);
  }
  function onDragOver(e: ReactDragEvent) {
    if (!editable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave() {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragOver(false);
  }
  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    depth.current = 0;
    setDragOver(false);
    if (!editable) return;
    try {
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onDropFiles(files);
    } catch {
      // A bad/unsupported drop must never strand the UI; the highlight is already off.
    }
  }

  return (
    <div
      style={{ ...S.zone, ...(dragOver ? S.zoneActive : null) }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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
  // The whole inputs block is the drop zone; padding gives the drag highlight
  // (fill + ring) room to breathe so it never crowds the header or the rows. The
  // negative side margins pull the zone out to the pane edges so the content still
  // lines up with the sections below it.
  zone: {
    border: "1px dashed transparent",
    borderRadius: 8,
    padding: "0.6rem",
    margin: "-0.3rem -0.6rem 0.6rem",
    transition: "background 80ms, border-color 80ms",
  },
  zoneActive: { borderColor: "var(--accent)", background: "var(--surface-2)" },
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
