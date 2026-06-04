/**
 * Policy defaults and layering. Locks the default values, the merge
 * precedence (per-call over instance over default), the replace-not-concat
 * semantics for list fields, and the metadata partial-fill behaviour.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, DEFAULT_STORE_EXTENSIONS, resolvePolicy } from "../src/policy.js";
import type { FilterRule } from "../src/types.js";

const ruleA: FilterRule = { pattern: "a", match: "glob", target: "both" };
const ruleB: FilterRule = { pattern: "b", match: "glob", target: "both" };

describe("DEFAULT_POLICY", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_POLICY.junk).toBe("builtin");
    expect(DEFAULT_POLICY.emptyFiles).toBe("keep");
    expect(DEFAULT_POLICY.emptyDirs).toBe("keep");
    expect(DEFAULT_POLICY.emptyDirDefinition).toBe("recursive");
    expect(DEFAULT_POLICY.invalidCharReplacement).toBe("_");
    expect(DEFAULT_POLICY.symlinks).toBe("ignore");
    expect(DEFAULT_POLICY.timestamps).toBe("preserve");
    expect(DEFAULT_POLICY.compression.mode).toBe("auto");
    expect(DEFAULT_POLICY.metadata).toEqual({ name: "_metadata.json", hash: true });
    expect(DEFAULT_POLICY.zip64).toBe("auto");
    expect(DEFAULT_POLICY.strict).toBe(false);
  });
});

describe("resolvePolicy", () => {
  it("returns the defaults when nothing is provided", () => {
    expect(resolvePolicy()).toEqual(DEFAULT_POLICY);
  });

  it("merges per-call over instance over defaults", () => {
    const resolved = resolvePolicy({ junk: "none", strict: false }, { strict: true });
    expect(resolved.junk).toBe("none");
    expect(resolved.strict).toBe(true);
  });

  it("replaces list fields wholesale rather than concatenating", () => {
    const resolved = resolvePolicy({ filters: [ruleA] }, { filters: [ruleB] });
    expect(resolved.filters).toEqual([ruleB]);
  });

  it("keeps the default store list when only the mode is overridden", () => {
    const resolved = resolvePolicy(undefined, { compression: { mode: "store-all" } });
    expect(resolved.compression.mode).toBe("store-all");
    expect(resolved.compression.storeExtensions).toEqual([...DEFAULT_STORE_EXTENSIONS]);
  });

  it("replaces the store list when provided", () => {
    const resolved = resolvePolicy(undefined, {
      compression: { storeExtensions: [".foo"] },
    });
    expect(resolved.compression.storeExtensions).toEqual([".foo"]);
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
    resolvePolicy(undefined, { filters: [ruleA], compression: { storeExtensions: [".x"] } });
    expect(DEFAULT_POLICY.filters).toEqual([]);
    expect(DEFAULT_POLICY.compression.storeExtensions).toEqual([...DEFAULT_STORE_EXTENSIONS]);
  });

  it("does not share the compression object with DEFAULT_POLICY", () => {
    const resolved = resolvePolicy();
    expect(resolved.compression).not.toBe(DEFAULT_POLICY.compression);
    resolved.compression.mode = "store-all";
    expect(DEFAULT_POLICY.compression.mode).toBe("auto");
  });
});
