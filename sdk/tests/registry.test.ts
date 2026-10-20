/**
 * The registry invariants. Severity alone gates: an `error` blocks the write, a
 * `warning` and an `info` never do (the planner tests assert error findings
 * drive `writable = false`). `finding()` stamps the registry tier by default and
 * accepts an explicit severity only for the configurable name rules.
 */

import { describe, expect, it } from "vitest";
import { finding, RULE_REGISTRY } from "../src/registry.ts";
import type { FindingRule } from "../src/types.ts";

const ALL_RULES = Object.keys(RULE_REGISTRY) as FindingRule[];

describe("RULE_REGISTRY", () => {
  it("gives every rule a severity and a disposition", () => {
    for (const rule of ALL_RULES) {
      const spec = RULE_REGISTRY[rule];
      expect(["error", "warning", "info"], rule).toContain(spec.severity);
      expect(typeof spec.disposition, rule).toBe("string");
    }
  });

  it("keeps the structural rules at the error tier", () => {
    for (const rule of ["path.traversal", "collision.case", "collision.post-fix"] as const) {
      expect(RULE_REGISTRY[rule].severity, rule).toBe("error");
    }
  });

  it("keeps every verification rule at the error tier, so any of them fails a verification", () => {
    for (const rule of ALL_RULES.filter((r) => r.startsWith("verify."))) expect(RULE_REGISTRY[rule].severity, rule).toBe("error");
  });
});

describe("finding factory", () => {
  it("defaults the severity to the registry tier", () => {
    for (const rule of ALL_RULES) {
      const f = finding(rule, "some/path", "message");
      expect(f.rule, rule).toBe(rule);
      expect(f.severity, rule).toBe(RULE_REGISTRY[rule].severity);
    }
  });

  it("honors an explicit severity override (the name rules)", () => {
    expect(finding("name.invalid-char", "p", "m", { severity: "error" }).severity).toBe("error");
    expect(finding("name.nfd", "p", "m", { severity: "warning" }).severity).toBe("warning");
    expect(finding("name.reserved", "p", "m", { severity: "info" }).severity).toBe("info");
  });

  it("omits fix when not provided and preserves it when given", () => {
    const without = finding("name.suspicious", "p", "m");
    expect(without.fix).toBeUndefined();
    const withFix = finding("name.invalid-char", "p", "m", { fix: { kind: "rename", to: "p_" } });
    expect(withFix.fix).toEqual({ kind: "rename", to: "p_" });
  });
});
