import { describe, expect, it } from "vitest";
import { toPlanReport } from "../../../src/gui/shared/plan-report";
import type { Finding, PlanData, PlannedEntry } from "../../../src/gui/shared/api";

const entry = (archivePath: string, over: Partial<PlannedEntry> = {}): PlannedEntry =>
  ({ archivePath, originalPath: archivePath, type: "file", method: "deflate", excluded: false, findings: [], ...over });

describe("toPlanReport", () => {
  it("sends the window only the entries the report shows, with the summary and every finding", () => {
    // An untouched file, and one renamed only because its folder was, add no row.
    const flagged: Finding = { rule: "name.nfd", severity: "info" as const, path: "b", message: "m" };
    const plan = {
      mode: "plan", output: "/out.zip", log: null, writable: true,
      summary: { total: 5, included: 4, excluded: 1, renamed: 1, warnings: 0, errors: 0, zip64: false },
      findings: [flagged],
      entries: [
        entry("a"),
        entry("b", { findings: [flagged] }),
        entry("c", { excluded: true }),
        entry("Y", { originalPath: "y" }),
        entry("D/inside.txt", { originalPath: "d/inside.txt" }),
      ],
    } as PlanData;
    const report = toPlanReport(plan);
    expect(report.entries.map((e) => e.archivePath)).toEqual(["b", "c", "Y"]);
    expect(report).toMatchObject({ writable: true, summary: plan.summary, findings: [flagged] });
    expect(report).not.toHaveProperty("output");
  });
});
