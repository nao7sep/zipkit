/**
 * Names Windows cannot hold are renamed at extraction there, with the fixes
 * ZipKit applies when it creates an archive, and the collision check compares
 * the renamed targets, so two entries that would land on one Windows name are
 * refused rather than one overwriting the other.
 */

import { describe, expect, it } from "vitest";
import { extractionSegments, windowsSafeSegment } from "../../../src/sdk/extract/windowsNames.js";
import { findTargetCollision } from "../../../src/sdk/extract/targetCollision.js";
import type { ReadEntry } from "../../../src/sdk/extract/zipReader.js";

describe("windowsSafeSegment", () => {
  it.each([
    ["CON", "CON_"],
    ["aux.txt", "aux_.txt"],
    ["lpt1.log", "lpt1_.log"],
    ["notes:stream", "notes_stream"],
    ['a<b>c"d|e?f*g', "a_b_c_d_e_f_g"],
    ["trailing. ", "trailing"],
    ["...", "_"],
    ["bell\u0007", "bell"],
  ])("renames %j to %j", (segment, fixed) => {
    expect(windowsSafeSegment(segment)).toBe(fixed);
  });

  it.each(["report.pdf", "Console.txt", "a..b", "パスポート.pdf", "パス.pdf"])("leaves %j as it is", (segment) => {
    expect(windowsSafeSegment(segment)).toBe(segment);
  });

  it("renames only on Windows", () => {
    expect(extractionSegments(["dir:1", "CON"], "win32")).toEqual(["dir_1", "CON_"]);
    expect(extractionSegments(["dir:1", "CON"], "darwin")).toEqual(["dir:1", "CON"]);
  });
});

describe("findTargetCollision with Windows names", () => {
  const entry = (archivePath: string, type: ReadEntry["type"] = "file") => ({ archivePath, type }) as ReadEntry;

  it("refuses two entries that one Windows name would hold, and keeps them apart elsewhere", () => {
    const entries = [entry("a:b.txt"), entry("a_b.txt")];
    expect(findTargetCollision(entries, "win32")).toEqual(["a:b.txt", "a_b.txt"]);
    expect(findTargetCollision(entries, "darwin")).toBeNull();
  });

  it("refuses a case-only pair on every platform, as before", () => {
    expect(findTargetCollision([entry("A.txt"), entry("a.txt")], "linux")).not.toBeNull();
  });
});
