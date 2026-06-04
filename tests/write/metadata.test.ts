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
  birthtimeNs: 1_577_836_800_000_000_000n,
  mode: 0o120777,
  transformations: [],
  linkTarget: "target",
};

function metaEntries(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.entries as Array<Record<string, unknown>>;
}

describe("buildMetadata", () => {
  it("records a symlink's classification losslessly", () => {
    const doc = buildMetadata(plan, DEFAULT_POLICY, [{ writeEntry: symlink, crc32: 123 }], 0n);
    expect(metaEntries(doc)[0]?.type).toBe("symlink");
    expect(doc.createdUtc).toBeDefined();
  });

  it("omits volatile fields under deterministic output", () => {
    const doc = buildMetadata(
      plan,
      { ...DEFAULT_POLICY, deterministic: true },
      [{ writeEntry: symlink, crc32: 123 }],
      1n,
    );
    expect(doc.createdUtc).toBeUndefined();
    expect(metaEntries(doc)[0]?.mtimeNs).toBeUndefined();
  });
});
