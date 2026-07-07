/**
 * Policy defaults and layering. Locks the default values, the merge
 * precedence (per-call over instance over default), the replace-not-concat
 * semantics for list fields, the additive `store`, and the metadata
 * partial-fill behaviour.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, NAME_DEFAULTS, resolvePolicy } from "../../src/sdk/policy.js";
import type { FilterRule } from "../../src/sdk/types.js";

const ruleA: FilterRule = { pattern: "a", match: "glob", target: "both" };
const ruleB: FilterRule = { pattern: "b", match: "glob", target: "both" };

describe("DEFAULT_POLICY", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_POLICY.junk).toBe("builtin");
    expect(DEFAULT_POLICY.emptyFiles).toBe("keep");
    expect(DEFAULT_POLICY.emptyDirs).toBe("keep");
    expect(DEFAULT_POLICY.names).toEqual(NAME_DEFAULTS);
    expect(DEFAULT_POLICY.names.invalidCharReplacement).toBe("_");
    expect(DEFAULT_POLICY.symlinks).toBe("ignore");
    expect(DEFAULT_POLICY.compression.stored).toBe("builtin");
    expect(DEFAULT_POLICY.compression.store).toEqual([]);
    expect(DEFAULT_POLICY.compression.level).toBe(6);
    expect(DEFAULT_POLICY.metadata).toEqual({ name: "_metadata.json", hash: true });
  });

  it("defaults every name guardrail to fix (suspicious to warn)", () => {
    expect(DEFAULT_POLICY.names.nfc).toBe("fix");
    expect(DEFAULT_POLICY.names.invalidChars).toBe("fix");
    expect(DEFAULT_POLICY.names.controlChars).toBe("fix");
    expect(DEFAULT_POLICY.names.trailingDotSpace).toBe("fix");
    expect(DEFAULT_POLICY.names.reserved).toBe("fix");
    expect(DEFAULT_POLICY.names.suspicious).toBe("warn");
  });
});

describe("resolvePolicy", () => {
  it("returns the defaults when nothing is provided", () => {
    expect(resolvePolicy()).toEqual(DEFAULT_POLICY);
  });

  it("merges per-call over instance over defaults", () => {
    const resolved = resolvePolicy(
      { junk: "none", symlinks: "preserve" },
      { symlinks: "follow" },
    );
    expect(resolved.junk).toBe("none");
    expect(resolved.symlinks).toBe("follow");
  });

  it("deep-merges a partial names object over the defaults", () => {
    const resolved = resolvePolicy(undefined, { names: { invalidChars: "error" } });
    expect(resolved.names.invalidChars).toBe("error");
    // The unset guardrails keep their defaults.
    expect(resolved.names.nfc).toBe("fix");
    expect(resolved.names.invalidCharReplacement).toBe("_");
  });

  it("replaces list fields wholesale rather than concatenating", () => {
    const resolved = resolvePolicy({ filters: [ruleA] }, { filters: [ruleB] });
    expect(resolved.filters).toEqual([ruleB]);
  });

  it("replaces the nested compression.store list rather than concatenating", () => {
    // The replace-not-concat rule reaches nested list fields too: the per-call
    // store wins outright, never appended to the instance store. (Guards against
    // a regression to plain defu, which would yield ['b', 'a'] here.)
    const resolved = resolvePolicy(
      { compression: { store: ["a"] } },
      { compression: { store: ["b"] } },
    );
    expect(resolved.compression.store).toEqual([".b"]);
  });

  it("carries an instance list down when the call omits it", () => {
    // A list set only on the instance layer survives — replacement means "the
    // most specific layer that set it wins," not "drop unless the call sets it."
    const resolved = resolvePolicy(
      { filters: [ruleA], compression: { store: ["a"] } },
      undefined,
    );
    expect(resolved.filters).toEqual([ruleA]);
    expect(resolved.compression.store).toEqual([".a"]);
  });

  it("keeps store empty when only the baseline is overridden", () => {
    const resolved = resolvePolicy(undefined, { compression: { stored: "none" } });
    expect(resolved.compression.stored).toBe("none");
    expect(resolved.compression.store).toEqual([]);
    expect(resolved.compression.level).toBe(6);
  });

  it("carries store additions and a level override", () => {
    const resolved = resolvePolicy(undefined, {
      compression: { store: [".foo"], level: 9 },
    });
    expect(resolved.compression.store).toEqual([".foo"]);
    expect(resolved.compression.level).toBe(9);
  });

  it("normalizes store extensions to lowercase-dotted form", () => {
    const resolved = resolvePolicy(undefined, {
      compression: { store: ["txt", ".BIN", ".Iso"] },
    });
    expect(resolved.compression.store).toEqual([".txt", ".bin", ".iso"]);
  });

  it("fills metadata defaults — name and hash on — for a partial metadata object", () => {
    const resolved = resolvePolicy(undefined, { metadata: {} });
    expect(resolved.metadata).toEqual({ name: "_metadata.json", hash: true });
  });

  it("keeps an explicit hash:false opt-out", () => {
    const resolved = resolvePolicy(undefined, { metadata: { hash: false } });
    expect(resolved.metadata).toEqual({ name: "_metadata.json", hash: false });
  });

  it("keeps metadata disabled when set to false", () => {
    expect(resolvePolicy(undefined, { metadata: false }).metadata).toBe(false);
  });

  it("does not mutate DEFAULT_POLICY across calls", () => {
    resolvePolicy(undefined, { filters: [ruleA], compression: { store: [".x"] } });
    expect(DEFAULT_POLICY.filters).toEqual([]);
    expect(DEFAULT_POLICY.compression.store).toEqual([]);
  });

  it("does not share the compression object with DEFAULT_POLICY", () => {
    const resolved = resolvePolicy();
    expect(resolved.compression).not.toBe(DEFAULT_POLICY.compression);
    resolved.compression.stored = "none";
    expect(DEFAULT_POLICY.compression.stored).toBe("builtin");
  });
});
