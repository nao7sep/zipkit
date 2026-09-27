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
 * delivery, clears presentation on receiver/window terminal events, and reports
 * every committed non-success beside the list. The window's separate
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
import { useDismissAlignOffset } from "../dismissAlign";
import { COLOR, orderedEntries } from "../view";
import { CloseIcon } from "./Icon";
import { ReceiverResultNotice } from "./ReceiverResultNotice";
import { useI18n, type Translator } from "../i18n/I18nContext";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { message } from "../../../shared/i18n/translate";

const KIND_LABEL: Record<PathKind, MessageKey> = {
  directory: "inputs.directory",
  file: "inputs.file",
  nonexistent: "inputs.missing",
  other: "inputs.other",
};

function kindColor(kind: PathKind): string {
  if (kind === "nonexistent") return COLOR.bad;
  if (kind === "other") return COLOR.warn;
  return "var(--text-2)";
}

/** One row: path text plus its remove X. A row of its own (rather than an
 * inline `.map`) so the X's first-line alignment (useDismissAlignOffset) can
 * measure THIS row's own path text — every row's path can wrap to a
 * different number of lines.
 *
 * This is a `position: relative` runtime measurement, not pure CSS, and that
 * is deliberate: the row keeps its original `alignItems: "center"`, so a
 * one-line path is already correctly centered on the button for free, while
 * a wrapped path needs the X pulled up by a fixed amount once its own
 * rendered height passes the button's. A single static CSS value (e.g.
 * `align-self: flex-start` + a constant `margin-block`) cannot serve both:
 * the flex-start reference that makes the wrapped case's shift independent
 * of line count also decouples the button from the row's own height, so it
 * no longer benefits from the centering that already made the one-line case
 * correct — verified empirically (scratchpad/redesign/xalign/zipkit):
 * `align-self: flex-start; margin-block: calc((line-height - control-h)/2)`
 * fixes the wrapped case (offset ~0.2px, matching HEAD's row height and path
 * position exactly) but regresses the one-line case to ~5.6px off (from
 * ~0.2px before). Measuring the path's actual rendered height at runtime is
 * what lets a single formula, `(line height - rendered height) / 2`, cover
 * both cases (it evaluates to 0 exactly when the path is one line). */
function InputRow({
  path,
  kind,
  canRemove,
  onRemove,
  t,
}: {
  path: string;
  kind?: PathKind;
  canRemove: boolean;
  onRemove: (path: string) => void;
  t: Translator["t"];
}) {
  const pathRef = useRef<HTMLSpanElement>(null);
  const dismissOffset = useDismissAlignOffset(pathRef);

  return (
    <li className="input-row" style={S.row}>
      {kind && <span style={{ ...S.kind, color: kindColor(kind) }}>{t(KIND_LABEL[kind])}</span>}
      <span ref={pathRef} style={S.path} title={path}>
        {path}
      </span>
      <button
        className="icon"
        style={{ position: "relative", top: dismissOffset }}
        onClick={() => onRemove(path)}
        disabled={!canRemove}
        title={t(canRemove ? "inputs.removeFromJob" : "inputs.needsOne")}
        aria-label={t("inputs.removePath", { path })}
      >
        <CloseIcon />
      </button>
    </li>
  );
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
  const { t } = useI18n();
  const [dragActive, setDragActive] = useState(false);
  const rows: { path: string; kind?: PathKind }[] = job.entries
    ? orderedEntries(job.entries)
    : job.inputs.map((path) => ({ path }));
  const canRemove = editable && job.inputs.length > 1;

  const clearDrag = useCallback(() => {
    setDragActive(false);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", clearDrag);
    window.addEventListener("dragend", clearDrag);
    return () => {
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("dragend", clearDrag);
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
    setDragActive(true);
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
        result: { message: message("inputs.unsupportedDrop"), severity: "warning" },
      });
      return;
    }
    if (!editable) {
      onResult({
        operationKey,
        entryKey,
        result: { message: message("inputs.locked"), severity: "warning" },
      });
      return;
    }
    try {
      if (files.length === 0) {
        onResult({
          operationKey,
          entryKey,
          result: {
            message: message("result.dropUnavailable"),
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
          message: message("result.dropAddFailed"),
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
        result: { message: message("result.addInputsFailed"), severity: "error" },
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
        <span style={S.title}>{t("inputs.title")}</span>
        <button onClick={() => void onAddClick()} disabled={!editable}>
          {t("common.add")}
        </button>
      </div>
      <ul style={S.list}>
        {rows.map(({ path, kind }) => (
          <InputRow key={path} path={path} kind={kind} canRemove={canRemove} onRemove={onRemove} t={t} />
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


const S: Record<string, CSSProperties> = {
  zone: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "0.6rem",
    margin: "0 0 0.75rem",
  },
  zoneActive: {
    boxShadow: "inset 0 0 0 2px var(--accent-strong)",
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
  // Enough room that neighboring rows' hover highlights never touch.
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.25rem" },
  // Unchanged from plain centering: the row's height and the path's own
  // position come entirely from this (kind/path get no special treatment),
  // so wrapped copy sizes and sits exactly as it would with no X at all. The
  // X's own first-line alignment is a `position: relative` nudge on the
  // button itself (InputRow, above, via useDismissAlignOffset) — a paint-only
  // offset, so it never feeds back into this centering or the row's height.
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    minWidth: 0,
    padding: "0.2rem 0.4rem",
    borderRadius: 5,
  },
  // At least the column the English kinds need, and wider when a translation
  // is, so a kind never wraps or clips.
  kind: { fontSize: "0.7rem", fontWeight: 700, flexShrink: 0, minWidth: "4.2rem", whiteSpace: "nowrap" },
  // Full path, wrapping rather than truncating — in a management list, seeing the
  // whole path matters more than a tidy single line.
  path: { flex: 1, minWidth: 0, wordBreak: "break-all", fontSize: "0.85rem" },
};
