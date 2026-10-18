/**
 * Handing a plan to another process or worker. A plan carries the writer's
 * instructions out of band (see `internal/carrier.ts`), which a structured
 * clone — the copy `postMessage` makes — drops, so a plan copied across a
 * process boundary as it is cannot be written. `exportPlan` packages both
 * halves into one clonable value and `importPlan` puts them back together on
 * the other side, so `write` there behaves exactly as it would beside `plan`.
 *
 * The package holds the absolute source paths the writer reads, so it is for
 * crossing between an app's own processes: never log it, persist it as a record,
 * or send it off the machine. It is a structured-clone value, not JSON (sizes
 * may be bigint).
 */

import { attachInternals, readInternals, type PlanInternals } from "./internal/carrier.ts";
import { ZipKitError } from "./errors.ts";
import type { PlanData } from "./zipkit.ts";

const FORMAT = "zipkit.plan-transfer/1";

/** A plan packaged to cross a process boundary; opaque apart from its `plan`. */
export interface PlanTransfer {
  readonly format: typeof FORMAT;
  /** The public plan, as `plan()` returned it. */
  readonly plan: PlanData;
  /** The writer's instructions; not for the caller to read or change. */
  readonly internals: unknown;
}

/** Package a plan from `plan()` to hand to another process for `write()`. */
export function exportPlan(plan: PlanData): PlanTransfer {
  const internals = readInternals(plan);
  if (internals === undefined) {
    throw new ZipKitError("plan.not-exportable", "only a plan returned by plan() can be exported");
  }
  return { format: FORMAT, plan, internals };
}

/** Rebuild a plan from `exportPlan`'s package, ready for `write()`. */
export function importPlan(transfer: PlanTransfer): PlanData {
  if (transfer === null || typeof transfer !== "object" || transfer.format !== FORMAT || typeof transfer.internals !== "object" || transfer.internals === null) {
    throw new ZipKitError("plan.transfer-invalid", "not a plan exported by exportPlan()");
  }
  attachInternals(transfer.plan, transfer.internals as PlanInternals);
  return transfer.plan;
}
