/**
 * The plan → write handoff. A `Plan` is a public, serializable record and must
 * never carry absolute source paths. But `write(plan)` is self-contained:
 * given only a plan, it must read the right bytes from disk. We reconcile the
 * two by attaching the writer's instructions to the plan through a
 * symbol-keyed, non-enumerable property. `JSON.stringify` — used by both
 * `--json` and the metadata serializer — never sees it, so the absolute paths
 * are stripped by construction, while the data still travels with the plan
 * object across the handoff with no instance coupling.
 */

import type { ArchivePolicy, Plan } from "../types.js";
import type { WriteEntry } from "./types.js";

export interface PlanInternals {
  /** Included entries, in plan order, ready for the writer. */
  writeEntries: WriteEntry[];
  /** The resolved policy governing timestamps, metadata, zip64, names. */
  policy: ArchivePolicy;
  /** The archive comment from the spec, written to the EOCD and the metadata. */
  comment?: string;
}

const CARRIER = Symbol("zipkit.internals");

interface Carried {
  [CARRIER]?: PlanInternals;
}

/** Attach writer instructions to a plan without making them enumerable. */
export function attachInternals(plan: Plan, internals: PlanInternals): void {
  Object.defineProperty(plan, CARRIER, {
    value: internals,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/** Read writer instructions previously attached to a plan, if present. */
export function readInternals(plan: Plan): PlanInternals | undefined {
  return (plan as Carried)[CARRIER];
}
