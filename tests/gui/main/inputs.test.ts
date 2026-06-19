/**
 * Tests for input-path classification (GUI/main plumbing for the job label, the
 * input-CRUD list, and the trash-originals gate). The mapping and order are pinned
 * with a fake stat so no real filesystem is touched.
 */

import { describe, expect, it } from "vitest";
import type { Stats } from "node:fs";
import { classifyPathsWith, kindFromStat } from "../../../src/gui/main/inputs.js";

const asDir = { isDirectory: () => true, isFile: () => false } as Stats;
const asFile = { isDirectory: () => false, isFile: () => true } as Stats;
const asOther = { isDirectory: () => false, isFile: () => false } as Stats;

describe("kindFromStat", () => {
  it("maps a stat outcome to a kind", () => {
    expect(kindFromStat(asDir)).toBe("directory");
    expect(kindFromStat(asFile)).toBe("file");
    expect(kindFromStat(asOther)).toBe("other");
    expect(kindFromStat(null)).toBe("nonexistent");
  });
});

describe("classifyPathsWith", () => {
  it("classifies each path, preserving order, and reports missing ones", async () => {
    const table: Record<string, Stats | null> = {
      "/dir": asDir,
      "/file.txt": asFile,
      "/gone": null,
    };
    const entries = await classifyPathsWith(
      ["/dir", "/file.txt", "/gone"],
      async (p) => table[p] ?? null,
    );
    expect(entries).toEqual([
      { path: "/dir", kind: "directory" },
      { path: "/file.txt", kind: "file" },
      { path: "/gone", kind: "nonexistent" },
    ]);
  });

  it("returns an empty list for no paths", async () => {
    expect(await classifyPathsWith([], async () => null)).toEqual([]);
  });
});
