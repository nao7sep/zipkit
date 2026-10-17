/**
 * Empty-file skip (pass 3), tested directly. Only under `emptyFiles: "skip"` is
 * a zero-byte file dropped — and as a selection choice, not a defect, so it
 * carries no finding, just an exclusion. Non-empty files, directories, and the
 * default `keep` policy are untouched.
 */

import { describe, expect, it } from "vitest";
import { applyEmptyFiles } from "../../../src/sdk/plan/emptyFiles.js";
import { resolvePolicy } from "../../../src/sdk/policy.js";
import { workItem } from "../../helpers/synthetic.js";

const skip = resolvePolicy(undefined, { emptyFiles: "skip" });
const keep = resolvePolicy(undefined, { emptyFiles: "keep" });

describe("applyEmptyFiles", () => {
  it("excludes a zero-byte file under skip with no finding", () => {
    const items = [workItem({ archivePath: "empty.txt", size: 0 })];
    applyEmptyFiles(items, skip);
    expect(items[0]!.excluded).toBe(true);
    expect(items[0]!.emitExplicit).toBe(false);
    expect(items[0]!.excludeReason).toMatch(/empty file skipped/);
    expect(items[0]!.findings).toEqual([]);
  });

  it("keeps a zero-byte file under the default keep policy", () => {
    const items = [workItem({ archivePath: "empty.txt", size: 0 })];
    applyEmptyFiles(items, keep);
    expect(items[0]!.excluded).toBe(false);
  });

  it("leaves a non-empty file untouched under skip", () => {
    const items = [workItem({ archivePath: "a.txt", size: 1 })];
    applyEmptyFiles(items, skip);
    expect(items[0]!.excluded).toBe(false);
  });

  it("never touches a zero-size directory entry", () => {
    const items = [workItem({ archivePath: "d", type: "dir", size: 0 })];
    applyEmptyFiles(items, skip);
    expect(items[0]!.excluded).toBe(false);
  });
});
