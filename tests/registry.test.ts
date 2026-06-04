/**
 * The registry invariants (§9.3). These lock the severity contract: the tier of
 * a rule is coupled exactly to its blocking behaviour, so a tier cannot be
 * changed without a visible, tested change. Together with the planner tests
 * (which assert that error findings drive `writable = false`), these enforce
 * the three §9.3 invariants.
 */

import { describe, expect, it } from "vitest";
import { finding, isKnownRule, RULE_ORDER, RULE_REGISTRY, ruleBlocks } from "../src/registry.js";
import type { RuleId } from "../src/registry.js";

const ALL_RULES = RULE_ORDER;

describe("RULE_REGISTRY", () => {
  it("couples blocksNormally to the error tier exactly", () => {
    for (const rule of ALL_RULES) {
      const spec = RULE_REGISTRY[rule];
      expect(spec.blocksNormally, rule).toBe(spec.severity === "error");
    }
  });

  it("couples blocksUnderStrict to the non-info tiers exactly", () => {
    for (const rule of ALL_RULES) {
      const spec = RULE_REGISTRY[rule];
      expect(spec.blocksUnderStrict, rule).toBe(spec.severity !== "info");
    }
  });

  it("never lets an info rule block, under any gating", () => {
    for (const rule of ALL_RULES) {
      if (RULE_REGISTRY[rule].severity !== "info") continue;
      expect(ruleBlocks(rule, false), rule).toBe(false);
      expect(ruleBlocks(rule, true), rule).toBe(false);
    }
  });

  it("blocks every error rule unconditionally", () => {
    for (const rule of ALL_RULES) {
      if (RULE_REGISTRY[rule].severity !== "error") continue;
      expect(ruleBlocks(rule, false), rule).toBe(true);
      expect(ruleBlocks(rule, true), rule).toBe(true);
    }
  });

  it("blocks warnings only under strict gating", () => {
    for (const rule of ALL_RULES) {
      if (RULE_REGISTRY[rule].severity !== "warning") continue;
      expect(ruleBlocks(rule, false), rule).toBe(false);
      expect(ruleBlocks(rule, true), rule).toBe(true);
    }
  });

  it("contains exactly the documented rule set in pipeline order", () => {
    expect(RULE_ORDER).toEqual([
      "path.absolute",
      "path.traversal",
      "path.too-long",
      "macos.junk",
      "windows.junk",
      "entry.symlink",
      "name.nfd",
      "name.invalid-char",
      "name.control-char",
      "name.trailing-dot-space",
      "name.reserved",
      "name.suspicious",
      "entry.duplicate",
      "collision.case",
      "collision.post-fix",
      "time.pre-1980",
      "time.post-2107",
      "compat.zip64",
      "compat.zip64-required",
    ]);
  });

  it("recognizes known rules and rejects unknown ones", () => {
    expect(isKnownRule("name.nfd")).toBe(true);
    expect(isKnownRule("not.a.rule")).toBe(false);
  });
});

describe("finding factory", () => {
  it("stamps the severity from the registry, never inline", () => {
    for (const rule of ALL_RULES) {
      const f = finding(rule, "some/path", "message");
      expect(f.rule, rule).toBe(rule);
      expect(f.severity, rule).toBe(RULE_REGISTRY[rule].severity);
    }
  });

  it("omits fix when not provided and preserves it when given", () => {
    const without = finding("name.suspicious", "p", "m");
    expect(without.fix).toBeUndefined();
    const renamed: RuleId = "name.invalid-char";
    const withFix = finding(renamed, "p", "m", { kind: "rename", to: "p_" });
    expect(withFix.fix).toEqual({ kind: "rename", to: "p_" });
  });
});
