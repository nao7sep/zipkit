/**
 * The job state badge — a small dot + label colored by state. Shared by the queue
 * listbox row and the detail header, so it lives apart from both.
 */

import type { Job } from "../../../shared/api";
import { stateColor } from "../view";

export function StateBadge({ state }: { state: Job["state"] }) {
  return (
    <span style={{ color: stateColor(state), fontWeight: 600, fontSize: "0.8rem", whiteSpace: "nowrap" }}>
      ● {state}
    </span>
  );
}
