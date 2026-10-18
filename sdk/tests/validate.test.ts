/**
 * Spec and policy validation. Malformed input is rejected with a
 * an invalid error; valid input gains its filter-rule defaults.
 */

import { describe, expect, it } from "vitest";

import { validateExtractSpec, validatePolicy, validateSpec } from "../src/validate.ts";
import { exportPlan, importPlan, ZipKit } from "../src/index.ts";
import { invalidError } from "./helpers/errors.ts";

describe("validateSpec", () => {
  it("accepts a minimal spec", () => {
    const spec = validateSpec({ inputs: ["/a"] });
    expect(spec.inputs).toEqual(["/a"]);
  });

  it("applies filter-rule defaults", () => {
    const spec = validateSpec({
      inputs: ["/a"],
      policy: { filters: [{ pattern: "*.tmp" }] as never },
    });
    expect(spec.policy?.filters?.[0]).toEqual({
      pattern: "*.tmp",
      match: "glob",
      target: "both",
    });
  });

  it("rejects a filter rule with an unknown 'action' key (include is gone)", () => {
    expect(() =>
      validateSpec({ inputs: ["/a"], policy: { filters: [{ action: "include", pattern: "x" }] } as never }),
    ).toThrow(invalidError);
  });

  it("rejects an empty inputs array", () => {
    expect(() => validateSpec({ inputs: [] })).toThrow(invalidError);
  });

  it("rejects an exact-empty input without trimming legal path names", () => {
    expect(() => validateSpec({ inputs: [""] })).toThrow(invalidError);
    expect(validateSpec({ inputs: ["/ "] }).inputs).toEqual(["/ "]);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => validateSpec({ inputs: ["/a"], bogus: 1 } as never)).toThrow(invalidError);
  });

  it("rejects an invalid policy enum value", () => {
    expect(() => validateSpec({ inputs: ["/a"], policy: { junk: "weird" } as never })).toThrow(invalidError);
  });

  it("rejects an invalid regex filter pattern with an invalid error", () => {
    expect(() =>
      validateSpec({
        inputs: ["/a"],
        policy: { filters: [{ pattern: "[", match: "regex" }] as never },
      }),
    ).toThrow(invalidError);
  });

  it("accepts a valid regex filter pattern", () => {
    expect(() =>
      validateSpec({
        inputs: ["/a"],
        policy: { filters: [{ pattern: "\\.log$", match: "regex" }] as never },
      }),
    ).not.toThrow();
  });
});

describe("validatePolicy", () => {
  it("accepts a partial policy and applies filter defaults", () => {
    const policy = validatePolicy({ filters: [{ pattern: "x" }] as never });
    expect(policy.filters?.[0]?.match).toBe("glob");
  });

  it("rejects an invalid symlink mode", () => {
    expect(() => validatePolicy({ symlinks: "chase" } as never)).toThrow(invalidError);
  });
});

describe("safe single-component fields", () => {
  // The invalid-char replacement is substituted into a segment after the
  // traversal pass, so a separator or `..` would re-introduce absolute/escaping
  // entry names. It is held to the same single-safe-component standard as the
  // metadata file name.
  it.each(["/", "\\", "..", ".", "", "a/b", "../x", "<", "na:me"])(
    "rejects an unsafe names.invalidCharReplacement %j",
    (replacement) => {
      expect(() =>
        validatePolicy({ names: { invalidCharReplacement: replacement } } as never),
      ).toThrow(invalidError);
    },
  );

  it.each(["_", "-", "()", "__", "x", "fixed"])(
    "accepts a safe names.invalidCharReplacement %j",
    (replacement) => {
      expect(() =>
        validatePolicy({ names: { invalidCharReplacement: replacement } } as never),
      ).not.toThrow();
    },
  );

  it.each(["a/b", "..", ".", "with/slash", "dir/zipkit.json"])(
    "rejects an unsafe metadata.name %j",
    (name) => {
      expect(() => validatePolicy({ metadata: { name } } as never)).toThrow(invalidError);
    },
  );

  it("accepts a safe metadata.name", () => {
    expect(() => validatePolicy({ metadata: { name: "zipkit.json" } } as never)).not.toThrow();
  });
});

describe("new configuration surface", () => {
  it("accepts the name guardrail actions and rejects an unknown one", () => {
    expect(() => validatePolicy({ names: { nfc: "warn", reserved: "error" } } as never)).not.toThrow();
    expect(() => validatePolicy({ names: { nfc: "ignore" } } as never)).toThrow(invalidError);
  });

  it("rejects a fix action on suspicious (it is detection-only)", () => {
    expect(() => validatePolicy({ names: { suspicious: "fix" } } as never)).toThrow(invalidError);
  });

  it("rejects policy keys removed from the surface", () => {
    for (const key of ["collisionCase", "timestamps", "emptyDirDefinition", "zip64"]) {
      expect(() => validatePolicy({ [key]: "anything" } as never), key).toThrow(invalidError);
    }
  });

  it("rejects a spec root and object-form inputs", () => {
    expect(() => validateSpec({ inputs: ["/a"], root: "base" } as never)).toThrow(invalidError);
    expect(() => validateSpec({ inputs: [{ path: "a" }] } as never)).toThrow(invalidError);
  });

  it("bounds the deflate level to 1–9 integers", () => {
    expect(() => validatePolicy({ compression: { level: 9 } })).not.toThrow();
    expect(() => validatePolicy({ compression: { level: 0 } })).toThrow(invalidError);
    expect(() => validatePolicy({ compression: { level: 10 } })).toThrow(invalidError);
    expect(() => validatePolicy({ compression: { level: 6.5 } })).toThrow(invalidError);
  });

  it("accepts an archive comment and rejects one over 65535 bytes", () => {
    expect(() => validateSpec({ inputs: ["/a"], comment: "release build" })).not.toThrow();
    expect(() => validateSpec({ inputs: ["/a"], comment: "x".repeat(65536) })).toThrow(invalidError);
  });
});

describe("locations", () => {
  it("are absolute everywhere: the SDK resolves nothing against a working directory", async () => {
    expect(() => validateSpec({ inputs: ["relative"] })).toThrow(invalidError);
    expect(() => validateSpec({ inputs: ["/a"], output: "out.zip" })).toThrow(invalidError);
    expect(() => validateSpec({ inputs: ["/a"], outputDir: "out" })).toThrow(invalidError);
    expect(() => validateExtractSpec({ archive: "a.zip", dryRun: true })).toThrow(invalidError);
    expect(() => validateExtractSpec({ archive: "/a.zip", dest: "out" })).toThrow(invalidError);
    expect(() => new ZipKit({ logDir: "logs" })).toThrow(invalidError);
    expect(() => new ZipKit({ skipPaths: ["data"] })).toThrow(invalidError);
    const zip = new ZipKit();
    const relative = { code: "path.not-absolute", kind: "invalid", subject: "a.zip" };
    await expect(zip.list("a.zip")).rejects.toMatchObject(relative);
    await expect(zip.readManifest("a.zip")).rejects.toMatchObject(relative);
    await expect(zip.pathState("a.zip")).rejects.toMatchObject(relative);
    await expect(zip.classify(["a.zip"])).rejects.toMatchObject(relative);
    await expect(zip.pathResources(["a.zip"])).rejects.toMatchObject(relative);
    await expect(zip.compareSources({ inputs: ["/a"] }, "a.zip")).rejects.toMatchObject(relative);
    await expect(zip.checkRemoval({ inputs: ["/a"] }, "a.zip")).rejects.toMatchObject(relative);
  });
});

describe("call options and arguments", () => {
  it("are checked at every method, so a wrong value fails as an invalid call, never deep in a file operation", async () => {
    const zip = new ZipKit();
    const invalid = { name: "ZipKitError", kind: "invalid" };
    expect(() => new ZipKit({ logdir: "/tmp" } as never)).toThrow(invalidError);
    await expect(zip.plan({ inputs: ["/a"] }, { signal: { aborted: false } as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.extract({ archive: "/a.zip", dryRun: true }, { onEvent: "log" as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.pathState("/a", { signal: {} as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.classify("abc" as never)).rejects.toMatchObject(invalid);
    await expect(zip.pathResources(null as never)).rejects.toMatchObject(invalid);
    await expect(zip.readManifest("/a.zip", { name: "../x" })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.list("/a.zip", { timeZone: "Bogus/Zone" })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.write(null as never)).rejects.toMatchObject({ code: "write.no-internals", kind: "invalid" });
    await expect(zip.checkRemoval({ inputs: ["/a"] }, "/a.zip", { removed: 5 as never })).rejects.toMatchObject(invalid);
    expect(() => exportPlan(null as never)).toThrow(invalidError);
    expect(() => importPlan({ format: "zipkit.plan-transfer/1", internals: {}, plan: null } as never)).toThrow(invalidError);
  });
});
