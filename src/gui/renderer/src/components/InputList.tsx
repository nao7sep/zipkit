/**
 * The job's input list with add/remove (input CRUD). A job's inputs are not frozen
 * at creation: the user can add a folder/file they forgot or drop one they no
 * longer want, without rebuilding the job. Each row shows the full path and what
 * it is on disk (folder / file / missing), so a vanished input is visible. The
 * last input cannot be removed — a job must archive something.
 */

import type { CSSProperties } from "react";
import type { Job, PathKind } from "../../../shared/api";
import { COLOR } from "../view";

const KIND_LABEL: Record<PathKind, string> = {
  directory: "Folder",
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
}: {
  job: Job;
  editable: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
}) {
  const kindOf = new Map((job.entries ?? []).map((e) => [e.path, e.kind] as const));
  const canRemove = editable && job.inputs.length > 1;
  return (
    <>
      <div style={S.head}>
        <span style={S.title}>Inputs</span>
        <button onClick={onAdd} disabled={!editable}>
          Add…
        </button>
      </div>
      <ul style={S.list}>
        {job.inputs.map((path) => {
          const kind = kindOf.get(path);
          return (
            <li key={path} style={S.row}>
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
          );
        })}
      </ul>
    </>
  );
}

const S: Record<string, CSSProperties> = {
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    marginBottom: "0.5rem",
  },
  title: { fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-2)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.25rem" },
  row: { display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 },
  kind: { fontSize: "0.7rem", fontWeight: 700, flexShrink: 0, width: "3.6rem" },
  // Full path, wrapping rather than truncating — in a management list, seeing the
  // whole path matters more than a tidy single line.
  path: { flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: "0.85rem" },
};
