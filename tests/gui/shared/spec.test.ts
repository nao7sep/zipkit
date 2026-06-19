/**
 * Unit tests for the GUI's options -> ArchiveSpec mapping (pure; no Electron). A
 * bug here means the UI hands the SDK the wrong policy, so the mapping of each
 * option — and what is deliberately left to the SDK's defaults — is pinned here.
 */

import { describe, expect, it } from "vitest";
import { buildSpec, DEFAULT_OPTIONS, planAffectingChanged } from "../../../src/gui/shared/spec.js";

describe("buildSpec", () => {
  it("maps defaults to an inclusive policy with metadata + hashing on", () => {
    const spec = buildSpec(["/a"], DEFAULT_OPTIONS);
    expect(spec.inputs).toEqual(["/a"]);
    expect(spec.policy?.junk).toBe("builtin");
    expect(spec.policy?.symlinks).toBe("ignore");
    expect(spec.policy?.emptyDirs).toBe("keep");
    expect(spec.policy?.compression?.level).toBe(6);
    expect(spec.policy?.metadata).toEqual({ hash: true });
    expect(spec.policy?.names).toBeUndefined(); // default "fix" left to the SDK
    expect(spec.output).toBeUndefined(); // composed in the main process, not here
    expect(spec.overwrite).toBeUndefined();
    expect(spec.comment).toBeUndefined();
  });

  it("strict mode sets every name rule to error", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, strict: true });
    expect(spec.policy?.names).toMatchObject({
      nfc: "error",
      invalidChars: "error",
      controlChars: "error",
      trailingDotSpace: "error",
      reserved: "error",
      suspicious: "error",
    });
  });

  it("turns off the junk preset and the manifest when toggled off", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, junk: false, metadata: false });
    expect(spec.policy?.junk).toBe("none");
    expect(spec.policy?.metadata).toBe(false);
  });

  it("keeps the manifest but drops the hash when hashing is off", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, hash: false });
    expect(spec.policy?.metadata).toEqual({ hash: false });
  });

  it("carries overwrite and comment through (output is composed elsewhere)", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, overwrite: true, comment: "ship it" });
    expect(spec.overwrite).toBe(true);
    expect(spec.comment).toBe("ship it");
    expect(spec.output).toBeUndefined(); // never set by buildSpec
  });

  it("omits a blank/whitespace comment rather than passing an empty", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, comment: "   " });
    expect(spec.comment).toBeUndefined();
  });
});

describe("planAffectingChanged", () => {
  it("is false for write-only edits (level, comment, hash) — no re-plan needed", () => {
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, level: 1 })).toBe(false);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, comment: "hi" })).toBe(false);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, hash: false })).toBe(false);
  });
  it("is true when an option that changes the dry run lands", () => {
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, fileName: "x.zip" })).toBe(true);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, outputDir: "/out" })).toBe(true);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, junk: false })).toBe(true);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, strict: true })).toBe(true);
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, overwrite: true })).toBe(true);
  });
  it("is false when nothing changed", () => {
    expect(planAffectingChanged(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS })).toBe(false);
  });
});
