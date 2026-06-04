/**
 * Spec and policy validation. Malformed input is rejected with a
 * PolicyError; valid input gains its filter-rule defaults; the non-serializable
 * signal is carried through untouched.
 */

import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/errors.js";
import { validatePolicy, validateSpec } from "../src/validate.js";

describe("validateSpec", () => {
  it("accepts a minimal spec", () => {
    const spec = validateSpec({ inputs: ["a"] });
    expect(spec.inputs).toEqual(["a"]);
  });

  it("applies filter-rule defaults", () => {
    const spec = validateSpec({
      inputs: ["a"],
      policy: { filters: [{ action: "exclude", pattern: "*.tmp" }] as never },
    });
    expect(spec.policy?.filters?.[0]).toEqual({
      action: "exclude",
      pattern: "*.tmp",
      match: "glob",
      target: "both",
    });
  });

  it("rejects an empty inputs array", () => {
    expect(() => validateSpec({ inputs: [] })).toThrow(PolicyError);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => validateSpec({ inputs: ["a"], bogus: 1 } as never)).toThrow(PolicyError);
  });

  it("rejects an invalid policy enum value", () => {
    expect(() => validateSpec({ inputs: ["a"], policy: { junk: "weird" } as never })).toThrow(
      PolicyError,
    );
  });

  it("rejects an invalid regex filter pattern with a PolicyError", () => {
    expect(() =>
      validateSpec({
        inputs: ["a"],
        policy: { filters: [{ action: "exclude", pattern: "[", match: "regex" }] as never },
      }),
    ).toThrow(PolicyError);
  });

  it("accepts a valid regex filter pattern", () => {
    expect(() =>
      validateSpec({
        inputs: ["a"],
        policy: { filters: [{ action: "exclude", pattern: "\\.log$", match: "regex" }] as never },
      }),
    ).not.toThrow();
  });

  it("preserves the abort signal", () => {
    const controller = new AbortController();
    const spec = validateSpec({ inputs: ["a"], signal: controller.signal });
    expect(spec.signal).toBe(controller.signal);
  });
});

describe("validatePolicy", () => {
  it("accepts a partial policy and applies filter defaults", () => {
    const policy = validatePolicy({ filters: [{ action: "include", pattern: "x" }] as never });
    expect(policy.filters?.[0]?.match).toBe("glob");
  });

  it("rejects an invalid symlink mode", () => {
    expect(() => validatePolicy({ symlinks: "chase" } as never)).toThrow(PolicyError);
  });
});

describe("safe single-component fields", () => {
  // The invalid-char replacement is substituted into a segment after the
  // traversal pass, so a separator or `..` would re-introduce absolute/escaping
  // entry names. It is held to the same single-safe-component standard as the
  // metadata file name.
  it.each(["/", "\\", "..", ".", "", "a/b", "../x", "<", "na:me"])(
    "rejects an unsafe invalidCharReplacement %j",
    (replacement) => {
      expect(() => validatePolicy({ invalidCharReplacement: replacement })).toThrow(PolicyError);
    },
  );

  it.each(["_", "-", "()", "__", "x", "fixed"])(
    "accepts a safe invalidCharReplacement %j",
    (replacement) => {
      expect(() => validatePolicy({ invalidCharReplacement: replacement })).not.toThrow();
    },
  );

  it.each(["a/b", "..", ".", "with/slash", "dir/_metadata.json"])(
    "rejects an unsafe metadata.name %j",
    (name) => {
      expect(() => validatePolicy({ metadata: { name } } as never)).toThrow(PolicyError);
    },
  );

  it("accepts a safe metadata.name", () => {
    expect(() => validatePolicy({ metadata: { name: "_metadata.json" } } as never)).not.toThrow();
  });
});
