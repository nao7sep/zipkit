import { describe, expect, it } from "vitest";
import { findTargetCollision } from "../../../src/sdk/extract/targetCollision.js";
import type { ReadEntry } from "../../../src/sdk/extract/zipReader.js";

function entry(archivePath: string, type: ReadEntry["type"] = "file"): ReadEntry {
  return {
    archivePath,
    type,
    method: 0,
    crc32: 0,
    compSize: 0,
    uncompSize: 0,
    localOffset: 0,
    gpFlag: 0,
    externalAttr: 0,
    dosDate: 0,
    dosTime: 0,
    extra: Buffer.alloc(0),
  };
}

describe("extraction target collision preflight", () => {
  it("finds a non-directory ancestor even when a lexical sibling sorts between it and the child", () => {
    expect(findTargetCollision([entry("a"), entry("a-0"), entry("a/b.txt")])).toEqual([
      "a",
      "a/b.txt",
    ]);
  });

  it("handles a large clean manifest without pairwise descendant scans", () => {
    const entries = Array.from({ length: 25_000 }, (_, index) => entry(`root-${index}.txt`));
    expect(findTargetCollision(entries)).toBeNull();
  });
});
