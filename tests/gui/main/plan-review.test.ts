/**
 * What counts as a changed Report between the plan a user reviewed and the
 * fresh one Create makes: entry paths, renames, exclusions, findings and the
 * output path. Order does not count, since the scan's order is not fixed.
 */

import { describe, expect, it } from "vitest";
import { reportChanged } from "../../../src/gui/main/plan-review.js";
import type { PlanData } from "../../../src/gui/shared/api.js";

type Entry = PlanData["entries"][number];
const entry = (archivePath: string, over: Partial<Entry> = {}): Entry => ({
  archivePath,
  originalPath: archivePath,
  type: "file",
  method: "deflate",
  excluded: false,
  findings: [],
  ...over,
});
const plan = (entries: Entry[], over: Partial<PlanData> = {}): PlanData =>
  ({
    mode: "plan",
    output: "/out/a.zip",
    log: null,
    writable: true,
    summary: { total: entries.length, included: entries.length, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false },
    findings: entries.flatMap((e) => e.findings),
    entries,
    ...over,
  }) as PlanData;

const nfd = { rule: "name.nfd", severity: "info" as const, path: "café", message: "name normalized from NFD to NFC" };

describe("reportChanged", () => {
  it("is false for the same Report in another order", () => {
    expect(reportChanged(plan([entry("a"), entry("b")]), plan([entry("b"), entry("a")]))).toBe(false);
  });

  it("is true when an entry was added or removed", () => {
    expect(reportChanged(plan([entry("a")]), plan([entry("a"), entry("b")]))).toBe(true);
    expect(reportChanged(plan([entry("a"), entry("b")]), plan([entry("a")]))).toBe(true);
  });

  it("is true when a rename, an exclusion or a finding differs", () => {
    const base = plan([entry("café", { originalPath: "café", findings: [nfd] })]);
    expect(reportChanged(base, plan([entry("café", { originalPath: "café" })]))).toBe(true);
    expect(reportChanged(plan([entry("a")]), plan([entry("a", { excluded: true, excludeReason: "empty file skipped" })]))).toBe(true);
    expect(reportChanged(base, plan([entry("café", { originalPath: "café", findings: [{ ...nfd, severity: "warning" }] })]))).toBe(true);
  });

  it("is true when the output path differs", () => {
    expect(reportChanged(plan([entry("a")]), plan([entry("a")], { output: "/out/b.zip" }))).toBe(true);
  });
});
