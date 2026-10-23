/** Retain SDK plans behind the GUI handles while preserving each fixture's I/O. */
import { randomUUID } from "node:crypto";
import type { PlanData } from "zipkitsdk";
import type { EngineDeps } from "../../src/gui/main/queue-engine.js";
import { reportChanged } from "../../src/gui/main/plan-review.js";

type Plan = (inputs: Parameters<EngineDeps["plan"]>[0], options: Parameters<EngineDeps["plan"]>[1],
  signal: AbortSignal, onEvent: Parameters<EngineDeps["plan"]>[3]) => Promise<PlanData>;
type Write = (plan: PlanData, signal: AbortSignal, onEvent: Parameters<EngineDeps["write"]>[2],
  onPhysicalSettlement: Parameters<EngineDeps["write"]>[3]) => Promise<number | null>;

export function preparedPlans(deps: { plan: Plan; write: Write }): Pick<EngineDeps, "plan" | "write" | "releasePlan"> {
  const owners = new Map<string, Map<string, PlanData>>();
  return {
    async plan(inputs, options, signal, onEvent, owner, reviewed) {
      const data = await deps.plan(inputs, options, signal, onEvent);
      const retained = owners.get(owner) ?? new Map<string, PlanData>();
      const previous = reviewed === undefined ? undefined : retained.get(reviewed);
      const revision = randomUUID();
      retained.clear();
      retained.set(revision, data);
      owners.set(owner, retained);
      return { revision, output: data.output, writable: data.writable, summary: data.summary,
        scanIncomplete: data.findings.some((finding) => finding.rule === "entry.unlisted"),
        reviewChanged: reviewed !== undefined && (previous === undefined || reportChanged(previous, data)) };
    },
    write(reference, ...args) {
      for (const retained of owners.values()) {
        const data = retained.get(reference.revision);
        if (data) return deps.write(data, ...args);
      }
      throw new Error("Prepared plan is no longer available");
    },
    releasePlan(owner) { owners.delete(owner); },
  };
}
