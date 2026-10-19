import type { PlanData, WriteData } from "../../src/index.ts";

/** A `create` result that wrote the archive; a blocked plan fails the test. */
export function written(result: WriteData | PlanData): WriteData {
  if (result.mode !== "write") throw new Error(`create was refused: ${result.findings.map((f) => f.rule).join(", ")}`);
  return result;
}
