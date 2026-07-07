/**
 * The plan → write handoff. A `Plan` is a public, serializable record and must
 * never carry absolute source paths. But `write(plan)` is self-contained:
 * given only a plan, it must read the right bytes from disk. We reconcile the
 * two by attaching the writer's instructions to the plan through a
 * symbol-keyed, non-enumerable property. `JSON.stringify` — used by the metadata
 * serializer and any caller that serializes a plan — never sees it, so
 * the absolute paths are stripped by construction, while the data travels with the plan
 * object across the handoff with no instance coupling.
 */

import type { ArchivePolicy } from "../types.js";
import type { WriteEntry } from "./types.js";

export interface PlanInternals {
  /** Included entries, in plan order, ready for the writer. */
  writeEntries: WriteEntry[];
  /** The resolved policy governing selection, naming, compression, and metadata. */
  policy: ArchivePolicy;
  /** The archive comment from the spec, written to the EOCD and the metadata. */
  comment?: string;
}

const CARRIER = Symbol("zipkit.internals");

interface Carried {
  [CARRIER]?: PlanInternals;
}

/**
 * Attach the writer's instructions to a plan object without making them
 * enumerable, so `JSON.stringify` — used by the metadata serializer and any
 * caller that serializes a plan — never sees them and the absolute source paths
 * they hold are stripped by construction. They travel with the object across the
 * plan → write handoff.
 */
export function attachInternals(target: object, internals: PlanInternals): void {
  Object.defineProperty(target, CARRIER, {
    value: internals,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/** Read writer instructions previously attached to a plan object, if present. */
export function readInternals(target: object): PlanInternals | undefined {
  return (target as Carried)[CARRIER];
}
