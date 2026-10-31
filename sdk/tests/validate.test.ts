/**
 * Spec and policy validation. Malformed input is rejected with a
 * an invalid error; valid input gains its filter-rule defaults.
 */

import { describe, expect, it } from "vitest";

import { validatePolicy, validateSpec } from "../src/validate.ts";
import { ZipKit } from "../src/index.ts";
import { invalidError } from "./helpers/errors.ts";

describe("validateSpec", () => {
  it("accepts a minimal spec", () => {
    const spec = validateSpec({ inputs: ["/a"] });
    expect(spec.inputs).toEqual(["/a"]);
  });

  it("applies exclusion-pattern defaults", () => {
    const spec = validateSpec({
      inputs: ["/a"],
      policy: { exclusions: [{ pattern: "*.tmp" }] as never },
    });
    expect(spec.policy?.exclusions?.[0]).toEqual({
      pattern: "*.tmp",
      match: "glob",
      target: "both",
      ignoreCase: false,
    });
  });

  it("rejects an exclusion pattern with an unknown key", () => {
    expect(() =>
      validateSpec({ inputs: ["/a"], policy: { exclusions: [{ colour: "red", pattern: "x" }] } as never }),
    ).toThrow(invalidError);
  });

  it("rejects a glob ending in a slash whose target is file, since the slash names folders", () => {
    expect(() =>
      validateSpec({ inputs: ["/a"], policy: { exclusions: [{ pattern: "build/", target: "file" }] } as never }),
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
    expect(() => validateSpec({ inputs: ["/a"], policy: { symlinks: "weird" } as never })).toThrow(invalidError);
  });

  it("rejects an invalid regex filter pattern with an invalid error", () => {
    expect(() =>
      validateSpec({
        inputs: ["/a"],
        policy: { exclusions: [{ pattern: "[", match: "regex" }] as never },
      }),
    ).toThrow(invalidError);
  });

  it("accepts a valid regex filter pattern", () => {
    expect(() =>
      validateSpec({
        inputs: ["/a"],
        policy: { exclusions: [{ pattern: "\\.log$", match: "regex" }] as never },
      }),
    ).not.toThrow();
  });
});

describe("validatePolicy", () => {
  it("accepts a partial policy and applies filter defaults", () => {
    const policy = validatePolicy({ exclusions: [{ pattern: "x" }] as never });
    expect(policy.exclusions?.[0]?.match).toBe("glob");
  });

  it("rejects an invalid symlink mode", () => {
    expect(() => validatePolicy({ symlinks: "chase" } as never)).toThrow(invalidError);
  });
});

describe("safe single-component fields", () => {
  // The invalid-char replacement is substituted into a segment after the
  // traversal pass, so a separator or `..` would re-introduce absolute/escaping
  // entry names. It is held to the same single-safe-component standard as the
  // manifest file name.
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

  it.each(["a/b", "a/../b", "..", ".", "with/slash", "dir/zipkit.json", "CON", "bad:name.json"])(
    "rejects an unsafe manifest.name %j",
    (name) => {
      expect(() => validatePolicy({ manifest: { name } } as never)).toThrow(invalidError);
    },
  );

  it.each(["zipkit.json", "record.json", "記録.json"])("accepts a safe manifest.name %j", (name) => {
    expect(() => validatePolicy({ manifest: { name } } as never)).not.toThrow();
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
    const zip = new ZipKit();
    const relative = { code: "path.not-absolute", kind: "invalid", subject: "a.zip" };
    await expect(zip.verify({ archive: "a.zip" })).rejects.toMatchObject(relative);
    await expect(zip.pathState("a.zip")).rejects.toMatchObject(relative);
    await expect(zip.pathKinds(["a.zip"])).rejects.toMatchObject(relative);
    await expect(zip.removeOriginals({ spec: { inputs: ["/a"] }, archive: "a.zip", method: "delete" })).rejects.toMatchObject(relative);
  });
});

describe("call options and arguments", () => {
  it("are checked at every method, so a wrong value fails as an invalid call, never deep in a file operation", async () => {
    const zip = new ZipKit();
    const invalid = { name: "ZipKitError", kind: "invalid" };
    expect(() => new ZipKit({ colour: "red" } as never)).toThrow(invalidError);
    expect(() => new ZipKit({ caller: { name: "" } })).toThrow(invalidError);
    expect(() => new ZipKit({ caller: { name: "x".repeat(257) } })).toThrow(invalidError);
    expect(() => new ZipKit({ caller: { name: "App", build: 1 } as never })).toThrow(invalidError);
    expect(() => new ZipKit({ caller: { name: "App", version: "1.0.0" } })).not.toThrow();
    await expect(zip.plan({ inputs: ["/a"] }, { signal: { aborted: false } as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.verify({ archive: "/a.zip" }, { onEvent: "log" as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.verify({ archive: "/a.zip", manifest: "yes" as never })).rejects.toMatchObject({ code: "request.invalid" });
    await expect(zip.verify({ archive: "/a.zip", manifestName: "a/b" })).rejects.toMatchObject({ code: "request.invalid" });
    await expect(zip.pathState("/a", { signal: {} as never })).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.pathKinds("abc" as never)).rejects.toMatchObject(invalid);
    await expect(zip.write(null as never)).rejects.toMatchObject({ code: "plan.invalid", kind: "invalid" });
    await expect(zip.write({ mode: "plan", writable: true, instructions: { entries: "x" } } as never)).rejects.toMatchObject({ code: "plan.invalid" });
    await expect(zip.removeOriginals({ spec: { inputs: ["/a"] }, archive: "/a.zip", removed: 5 as never, method: "delete" })).rejects.toMatchObject(invalid);
    await expect(zip.removeOriginals({ spec: { inputs: ["/a"] }, archive: "/a.zip", method: "shred" as never })).rejects.toMatchObject({ code: "request.invalid" });
    // Moving to the Trash needs the host's Trash.
    await expect(zip.removeOriginals({ spec: { inputs: ["/a"] }, archive: "/a.zip", method: "trash" })).rejects.toMatchObject({ code: "request.invalid" });
    expect(() => new ZipKit({ trash: "bin" as never })).toThrow(invalidError);
  });

  it("refuse unknown keys, so a misspelt setting is never silently ignored", async () => {
    const zip = new ZipKit();
    await expect(zip.verify({ archive: "/a.zip", manfest: true } as never)).rejects.toMatchObject({ code: "request.invalid" });
    await expect(zip.removeOriginals({ spec: { inputs: ["/a"] }, archive: "/a.zip", method: "delete", remove: [] } as never)).rejects.toMatchObject({ code: "request.invalid" });
    await expect(zip.plan({ inputs: ["/a"] }, { manifest: true } as never)).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.verify({ archive: "/a.zip" }, { manifest: true } as never)).rejects.toMatchObject({ code: "options.invalid" });
    await expect(zip.pathState("/a", { onProgres: () => {} } as never)).rejects.toMatchObject({ code: "options.invalid" });
  });
});
