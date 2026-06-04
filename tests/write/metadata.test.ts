/**
 * Metadata builder. Locks the lossless symlink classification and the
 * omission of volatile fields under deterministic output.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/policy.js";
import { buildMetadata } from "../../src/write/metadata.js";
import type { WriteEntry } from "../../src/internal/types.js";
import type { Plan } from "../../src/types.js";

const plan: Plan = {
  output: "out.zip",
  outputExists: false,
  overwrite: false,
  writable: true,
  summary: { total: 1, included: 1, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false },
  entries: [],
  findings: [],
};

const symlink: WriteEntry = {
  archivePath: "link",
  originalPath: "link",
  sourcePath: "link",
  type: "symlink",
  method: "store",
  absolutePath: "",
  size: 6,
  mtimeNs: 1_577_836_800_000_000_000n,
  atimeNs: 1_577_836_800_000_000_000n,
  ctimeNs: 1_577_836_800_000_000_000n,
  birthtimeNs: 1_577_836_800_000_000_000n,
  mode: 0o120777,
  transformations: [],
  linkTarget: "target",
};

function metaEntries(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.entries as Array<Record<string, unknown>>;
}

describe("buildMetadata", () => {
  it("records a symlink's classification and all four UTC times losslessly", () => {
    const doc = buildMetadata(
      plan,
      DEFAULT_POLICY,
      [{ writeEntry: symlink, crc32: 123, compressedSize: 6 }],
      0n,
      "Asia/Tokyo",
    );
    const entry = metaEntries(doc)[0]!;
    expect(entry.type).toBe("symlink");
    expect(doc.createdUtc).toBeDefined();
    expect(doc.timeZone).toBe("Asia/Tokyo");
    // Each time is recorded as lossless ns plus an ISO-8601 string, in UTC.
    expect(entry.mtime).toEqual({ ns: "1577836800000000000", iso: "2020-01-01T00:00:00.000Z" });
    for (const key of ["mtime", "atime", "ctime", "btime"]) {
      expect((entry[key] as { ns: string }).ns).toBe("1577836800000000000");
    }
  });

  it("omits volatile fields under deterministic output", () => {
    const doc = buildMetadata(
      plan,
      { ...DEFAULT_POLICY, deterministic: true },
      [{ writeEntry: symlink, crc32: 123, compressedSize: 6 }],
      1n,
      "Asia/Tokyo",
    );
    expect(doc.createdUtc).toBeUndefined();
    expect(doc.timeZone).toBeUndefined();
    expect(metaEntries(doc)[0]?.mtime).toBeUndefined();
  });
});
