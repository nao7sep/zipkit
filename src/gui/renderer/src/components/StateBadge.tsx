/**
 * The job state badge — a colored pill (state-tinted fill + matching text and
 * border) shared by the queue listbox row and the Archive pane header. As a pill
 * it reads at a glance and, crucially, never gets visually swallowed when it sits
 * beside a long title: the header keeps it from shrinking, this keeps its shape.
 */

import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { stateColor, stateLabel, stateTint } from "../view";

export function StateBadge({ state }: { state: Job["state"] }) {
  const color = stateColor(state);
  const style: CSSProperties = {
    color,
    background: stateTint(state),
    border: `1px solid ${color}`,
    borderRadius: 999,
    padding: "0.1rem 0.55rem",
    fontWeight: 600,
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
  };
  return <span style={style}>{stateLabel(state)}</span>;
}
