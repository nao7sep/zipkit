/**
 * Empty-directory pass (pass 5), tested directly. A directory is *occupied* by a
 * content (non-empty) file descendant — a zero-byte file is not content. An
 * unoccupied directory is empty: `prune` drops it, `keep` keeps it. Every
 * directory that stays is emitted as its own entry, so its times are stored.
 */

import { describe, expect, it } from "vitest";
import { applyEmptyDirs } from "../../../src/sdk/plan/emptyDirs.js";
import { resolvePolicy } from "../../../src/sdk/policy.js";
import { workItem } from "../../helpers/synthetic.js";

const keep = resolvePolicy(undefined, { emptyDirs: "keep" });
const prune = resolvePolicy(undefined, { emptyDirs: "prune" });

describe("applyEmptyDirs", () => {
  it("emits a directory occupied by a content file", () => {
    const dir = workItem({ archivePath: "d", type: "dir" });
    const file = workItem({ archivePath: "d/a.txt", size: 10 });
    applyEmptyDirs([dir, file], prune);
    expect(dir.excluded).toBe(false);
    expect(dir.emitExplicit).toBe(true);
  });

  it("prunes an empty directory", () => {
    const dir = workItem({ archivePath: "e", type: "dir" });
    applyEmptyDirs([dir], prune);
    expect(dir.excluded).toBe(true);
    expect(dir.emitExplicit).toBe(false);
    expect(dir.excludeReason).toMatch(/empty directory pruned/);
  });

  it("emits a standalone empty directory under keep", () => {
    const dir = workItem({ archivePath: "e", type: "dir" });
    applyEmptyDirs([dir], keep);
    expect(dir.excluded).toBe(false);
    expect(dir.emitExplicit).toBe(true);
  });

  it("under keep, emits every empty directory in a nested chain", () => {
    const outer = workItem({ archivePath: "e", type: "dir" });
    const inner = workItem({ archivePath: "e/f", type: "dir" });
    applyEmptyDirs([outer, inner], keep);
    expect(outer.emitExplicit).toBe(true);
    expect(inner.emitExplicit).toBe(true);
  });

  it("treats a directory holding only a zero-byte file as empty", () => {
    const dir = workItem({ archivePath: "z", type: "dir" });
    const file = workItem({ archivePath: "z/empty.txt", size: 0 });
    applyEmptyDirs([dir, file], prune);
    expect(dir.excluded).toBe(true); // the zero-byte file does not occupy it
  });

  it("counts a preserved symlink as content that occupies its ancestors", () => {
    const dir = workItem({ archivePath: "d", type: "dir" });
    const link = workItem({ archivePath: "d/link", type: "symlink", emitExplicit: true });
    applyEmptyDirs([dir, link], prune);
    expect(dir.excluded).toBe(false);
    expect(dir.emitExplicit).toBe(true);
  });
});
