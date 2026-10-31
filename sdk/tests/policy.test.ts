/**
 * Policy layering: the merge precedence (per-call over instance over default),
 * the replace-not-concat semantics for list fields, the additive `store`, and
 * the manifest's partial fill.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, NAME_DEFAULTS, resolvePolicy } from "../src/policy.ts";
import type { ExclusionPattern } from "../src/types.ts";
import { DEFAULT_EXCLUSIONS } from "../src/filter/defaults.ts";

const ruleA: ExclusionPattern = { pattern: "a", match: "glob", target: "both", ignoreCase: false };
const ruleB: ExclusionPattern = { pattern: "b", match: "glob", target: "both", ignoreCase: false };

describe("DEFAULT_POLICY", () => {
  it("is frozen, so no caller can change what every call starts from", () => {
    expect(() => { (DEFAULT_POLICY.names as { nfc: string }).nfc = "none"; }).toThrow(TypeError);
    expect(() => { (DEFAULT_POLICY.exclusions as unknown[]).push({}); }).toThrow(TypeError);
    expect(resolvePolicy().names.nfc).toBe(NAME_DEFAULTS.nfc);
  });
});

describe("resolvePolicy", () => {
  it("returns the defaults when nothing is provided", () => {
    expect(resolvePolicy()).toEqual(DEFAULT_POLICY);
  });

  it("merges per-call over instance over defaults", () => {
    const resolved = resolvePolicy(
      { exclusions: [], symlinks: "preserve" },
      { symlinks: "follow" },
    );
    expect(resolved.exclusions).toEqual([]);
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
    const resolved = resolvePolicy({ exclusions: [ruleA] }, { exclusions: [ruleB] });
    expect(resolved.exclusions).toEqual([ruleB]);
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
      { exclusions: [ruleA], compression: { store: ["a"] } },
      undefined,
    );
    expect(resolved.exclusions).toEqual([ruleA]);
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

  it("fills manifest defaults — name and hash on — for a partial manifest object", () => {
    const resolved = resolvePolicy(undefined, { manifest: {} });
    expect(resolved.manifest).toEqual({ name: "zipkit.json", hash: true });
  });

  it("keeps an explicit hash:false opt-out", () => {
    const resolved = resolvePolicy(undefined, { manifest: { hash: false } });
    expect(resolved.manifest).toEqual({ name: "zipkit.json", hash: false });
  });

  it("keeps manifest disabled when set to false", () => {
    expect(resolvePolicy(undefined, { manifest: false }).manifest).toBe(false);
  });

  it("does not mutate DEFAULT_POLICY across calls", () => {
    resolvePolicy(undefined, { exclusions: [ruleA], compression: { store: [".x"] } });
    expect(DEFAULT_POLICY.exclusions).toEqual(DEFAULT_EXCLUSIONS);
    expect(DEFAULT_POLICY.compression.store).toEqual([]);
  });

  it("does not share the compression object with DEFAULT_POLICY", () => {
    const resolved = resolvePolicy();
    expect(resolved.compression).not.toBe(DEFAULT_POLICY.compression);
    resolved.compression.stored = "none";
    expect(DEFAULT_POLICY.compression.stored).toBe("builtin");
  });
});
