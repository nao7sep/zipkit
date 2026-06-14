/**
 * Unit tests for the GUI's options -> ArchiveSpec mapping (pure; no Electron). A
 * bug here means the UI hands the SDK the wrong policy, so the mapping of each
 * option — and what is deliberately left to the SDK's defaults — is pinned here.
 */

import { describe, expect, it } from "vitest";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";

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
    expect(spec.output).toBeUndefined();
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

  it("carries a trimmed explicit output, overwrite, and comment through", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, output: "  out.zip  ", overwrite: true, comment: "ship it" });
    expect(spec.output).toBe("out.zip");
    expect(spec.overwrite).toBe(true);
    expect(spec.comment).toBe("ship it");
  });

  it("omits a blank/whitespace output and comment rather than passing empties", () => {
    const spec = buildSpec(["/a"], { ...DEFAULT_OPTIONS, output: "   ", comment: "" });
    expect(spec.output).toBeUndefined();
    expect(spec.comment).toBeUndefined();
  });
});
