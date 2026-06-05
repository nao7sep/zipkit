/**
 * The pure planning pipeline, table-driven over synthetic scan entries
 * with no filesystem access. These tests lock the load-bearing
 * behaviours: junk exclusion, name fixing and renames, collision and traversal
 * errors that block, dedup, empty-file and empty-directory handling, the two
 * empty-dir definitions, compression selection, the Zip64 verdict, timestamp
 * flagging, symlink modes, the per-rule name actions, and the output-existence
 * gate.
 *
 * `writable` doubles as the severity enforcement: error findings always block,
 * warnings and info never do. A name rule blocks only when its action is set to
 * `error`.
 */

import { describe, expect, it } from "vitest";
import { readInternals } from "../../src/internal/carrier.js";
import { planArchive } from "../../src/plan/plan.js";
import { resolvePolicy } from "../../src/policy.js";
import type { ArchivePolicy, Finding } from "../../src/types.js";
import { scanEntry, scanResult } from "../helpers/synthetic.js";
import type { ScanEntry } from "../../src/internal/types.js";

function plan(entries: ScanEntry[], policy: Partial<ArchivePolicy> = {}, over = {}) {
  return planArchive(scanResult(entries, over), resolvePolicy(undefined, policy));
}

function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

function written(p: ReturnType<typeof plan>): string[] {
  return (readInternals(p)?.writeEntries ?? []).map((e) => e.archivePath).sort();
}

describe("baseline", () => {
  it("plans clean files with no findings and is writable", () => {
    const p = plan([scanEntry({ archivePath: "a.txt" }), scanEntry({ archivePath: "b.txt" })]);
    expect(p.writable).toBe(true);
    expect(p.findings).toEqual([]);
    expect(p.summary).toMatchObject({ total: 2, included: 2, excluded: 0, renamed: 0, errors: 0 });
  });
});

describe("selection", () => {
  it("excludes junk with an info finding and stays writable", () => {
    const p = plan([scanEntry({ archivePath: "a.txt" }), scanEntry({ archivePath: ".DS_Store" })]);
    expect(p.writable).toBe(true);
    const ds = p.entries.find((e) => e.archivePath === ".DS_Store");
    expect(ds?.excluded).toBe(true);
    expect(rules(p.findings)).toContain("macos.junk");
  });

  it("skips zero-byte files under emptyFiles:skip", () => {
    const p = plan(
      [scanEntry({ archivePath: "empty.txt", size: 0 }), scanEntry({ archivePath: "a.txt" })],
      { emptyFiles: "skip" },
    );
    expect(p.entries.find((e) => e.archivePath === "empty.txt")?.excluded).toBe(true);
    expect(written(p)).toEqual(["a.txt"]);
  });
});

describe("name fixing", () => {
  it("normalizes an NFD name to NFC, renames, and logs info without blocking", () => {
    const nfd = `cafe${String.fromCodePoint(0x0301)}.txt`;
    const p = plan([scanEntry({ archivePath: nfd })]);
    expect(p.writable).toBe(true);
    const entry = p.entries[0];
    expect(entry?.archivePath).toBe(`caf${String.fromCodePoint(0x00e9)}.txt`);
    expect(entry?.originalPath).toBe(nfd);
    expect(p.summary.renamed).toBe(1);
    const nfdFinding = p.findings.find((f) => f.rule === "name.nfd");
    expect(nfdFinding?.severity).toBe("info");
  });

  it("blocks when a name rule action is set to error", () => {
    const nfd = `cafe${String.fromCodePoint(0x0301)}.txt`;
    const p = plan([scanEntry({ archivePath: nfd })], { names: { nfc: "error" } });
    expect(p.writable).toBe(false);
    // Left as-is (not normalized) and reported at the error tier.
    expect(p.entries[0]?.archivePath).toBe(nfd);
    expect(p.findings.find((f) => f.rule === "name.nfd")?.severity).toBe("error");
  });

  it("leaves a name untouched and silent when its action is none", () => {
    const nfd = `cafe${String.fromCodePoint(0x0301)}.txt`;
    const p = plan([scanEntry({ archivePath: nfd })], { names: { nfc: "none" } });
    expect(p.writable).toBe(true);
    expect(p.entries[0]?.archivePath).toBe(nfd);
    expect(rules(p.findings)).not.toContain("name.nfd");
  });

  it("blocks on a suspicious character when its action is error", () => {
    const zwsp = `a${String.fromCodePoint(0x200b)}b.txt`;
    const p = plan([scanEntry({ archivePath: zwsp })], { names: { suspicious: "error" } });
    expect(p.writable).toBe(false);
    // Suspicious characters are kept even at the error tier (never fixed).
    expect(p.entries[0]?.archivePath).toBe(zwsp);
    expect(p.findings.find((f) => f.rule === "name.suspicious")?.severity).toBe("error");
  });

  it("applies mixed actions on one path: fix NFC, warn on the invalid char", () => {
    const dirty = `cafe${String.fromCodePoint(0x0301)}<x.txt`;
    const p = plan([scanEntry({ archivePath: dirty })], { names: { invalidChars: "warn" } });
    // NFC normalized (fixed) but the `<` left in place (warn).
    expect(p.entries[0]?.archivePath).toBe(`caf${String.fromCodePoint(0x00e9)}<x.txt`);
    expect(p.writable).toBe(true);
    const byRule = Object.fromEntries(p.findings.map((f) => [f.rule, f.severity]));
    expect(byRule["name.nfd"]).toBe("info");
    expect(byRule["name.invalid-char"]).toBe("warning");
  });

  it("reports a fix on an as-introduced parent segment with no directory node", () => {
    const p = plan([scanEntry({ archivePath: "bad>name/file.txt" })]);
    expect(rules(p.findings)).toContain("name.invalid-char");
    expect(p.entries[0]?.archivePath).toBe("bad_name/file.txt");
  });

  it("reports a shared parent directory fix once, not once per child", () => {
    const dir = `cafe${String.fromCodePoint(0x0301)}`; // NFD: "cafe" + combining acute
    const p = plan([
      scanEntry({ archivePath: dir, type: "dir" }),
      scanEntry({ archivePath: `${dir}/a.txt` }),
      scanEntry({ archivePath: `${dir}/b.txt` }),
    ]);
    expect(p.findings.filter((f) => f.rule === "name.nfd")).toHaveLength(1);
  });
});

describe("timestamps far future", () => {
  it("flags a post-2107 modification time without blocking", () => {
    const p = plan([scanEntry({ archivePath: "future.txt", mtimeNs: BigInt(Date.UTC(2200, 0, 1)) * 1_000_000n })]);
    expect(rules(p.findings)).toContain("time.post-2107");
    expect(p.writable).toBe(true);
  });
});

describe("collisions", () => {
  it("flags a case-only collision between distinct sources as an error", () => {
    const p = plan([
      scanEntry({ archivePath: "Foo/x.txt", absolutePath: "/abs/1" }),
      scanEntry({ archivePath: "foo/x.txt", absolutePath: "/abs/2" }),
    ]);
    expect(p.writable).toBe(false);
    expect(rules(p.findings)).toContain("collision.case");
  });

  it("flags a substitution-induced exact collision as an error", () => {
    const p = plan([
      scanEntry({ archivePath: "a:b.txt", absolutePath: "/abs/1" }),
      scanEntry({ archivePath: "a_b.txt", absolutePath: "/abs/2" }),
    ]);
    expect(p.writable).toBe(false);
    expect(rules(p.findings)).toContain("collision.post-fix");
  });

  it("allows a case-only difference under collisionCase sensitive", () => {
    const entries = [
      scanEntry({ archivePath: "Foo/x.txt", absolutePath: "/abs/1" }),
      scanEntry({ archivePath: "foo/x.txt", absolutePath: "/abs/2" }),
    ];
    expect(plan(entries, { collisionCase: "sensitive" }).writable).toBe(true);
    // An exact post-fix collision is still an error even under sensitive.
    const exact = plan(
      [
        scanEntry({ archivePath: "a_b.txt", absolutePath: "/abs/1" }),
        scanEntry({ archivePath: "a_b.txt", absolutePath: "/abs/2" }),
      ],
      { collisionCase: "sensitive" },
    );
    expect(exact.writable).toBe(false);
    expect(rules(exact.findings)).toContain("collision.post-fix");
  });

  it("errors when a real entry collides with the reserved metadata name", () => {
    const p = plan([
      scanEntry({ archivePath: "_metadata.json", absolutePath: "/abs/1" }),
      scanEntry({ archivePath: "keep.txt", absolutePath: "/abs/2" }),
    ]);
    expect(p.writable).toBe(false);
    const f = p.findings.find((x) => x.rule === "collision.post-fix");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("_metadata.json");
  });

  it("permits the metadata name when metadata is disabled (no reservation)", () => {
    const p = plan([scanEntry({ archivePath: "_metadata.json", absolutePath: "/abs/1" })], {
      metadata: false,
    });
    expect(p.writable).toBe(true);
  });
});

describe("dedup", () => {
  it("collapses the same source from overlapping inputs to one entry (info)", () => {
    const p = plan([
      scanEntry({ archivePath: "dup.txt", absolutePath: "/abs/same" }),
      scanEntry({ archivePath: "dup.txt", absolutePath: "/abs/same" }),
    ]);
    expect(p.writable).toBe(true);
    expect(rules(p.findings)).toContain("entry.duplicate");
    expect(p.summary).toMatchObject({ total: 2, included: 1, excluded: 1 });
    expect(written(p)).toEqual(["dup.txt"]);
  });
});

describe("empty directories", () => {
  const tree = (): ScanEntry[] => [
    scanEntry({ archivePath: "A", type: "dir" }),
    scanEntry({ archivePath: "A/B", type: "dir" }),
    scanEntry({ archivePath: "A/B/C", type: "dir" }),
  ];

  it("prunes empty directories", () => {
    const p = plan(tree(), { emptyDirs: "prune" });
    expect(written(p)).toEqual([]);
  });

  it("keeps only leaf empties under the recursive definition", () => {
    const p = plan(tree(), { emptyDirs: "keep", emptyDirDefinition: "recursive" });
    expect(written(p)).toEqual(["A/B/C"]);
  });

  it("keeps every empty directory under the strict definition", () => {
    const p = plan(tree(), { emptyDirs: "keep", emptyDirDefinition: "strict" });
    expect(written(p)).toEqual(["A", "A/B", "A/B/C"]);
  });

  it("implies a directory occupied by a file rather than writing it", () => {
    const p = plan(
      [scanEntry({ archivePath: "A", type: "dir" }), scanEntry({ archivePath: "A/f.txt" })],
      { emptyDirs: "keep" },
    );
    expect(written(p)).toEqual(["A/f.txt"]);
  });
});

describe("compression", () => {
  it("stores already-compressed extensions and deflates the rest under auto", () => {
    const p = plan([
      scanEntry({ archivePath: "photo.jpg" }),
      scanEntry({ archivePath: "notes.txt" }),
    ]);
    const byName = Object.fromEntries(p.entries.map((e) => [e.archivePath, e.method]));
    expect(byName["photo.jpg"]).toBe("store");
    expect(byName["notes.txt"]).toBe("deflate");
  });

  it("deflates everything under stored:none, even a built-in store extension", () => {
    const p = plan([scanEntry({ archivePath: "photo.jpg" })], {
      compression: { stored: "none" },
    });
    expect(p.entries[0]?.method).toBe("deflate");
  });

  it("stores a store extension on top of the built-in set", () => {
    const p = plan(
      [
        scanEntry({ archivePath: "model.bin" }),
        scanEntry({ archivePath: "photo.jpg" }),
        scanEntry({ archivePath: "notes.txt" }),
      ],
      { compression: { store: [".bin"] } },
    );
    const byName = Object.fromEntries(p.entries.map((e) => [e.archivePath, e.method]));
    expect(byName["model.bin"]).toBe("store"); // added
    expect(byName["photo.jpg"]).toBe("store"); // built-in
    expect(byName["notes.txt"]).toBe("deflate"); // neither
  });

  it("under stored:none, store names the only stored extensions", () => {
    const p = plan(
      [scanEntry({ archivePath: "model.bin" }), scanEntry({ archivePath: "photo.jpg" })],
      { compression: { stored: "none", store: [".bin"] } },
    );
    const byName = Object.fromEntries(p.entries.map((e) => [e.archivePath, e.method]));
    expect(byName["model.bin"]).toBe("store"); // the only stored extension
    expect(byName["photo.jpg"]).toBe("deflate"); // built-in set is off
  });

  it("matches store case-insensitively", () => {
    const p = plan([scanEntry({ archivePath: "DATA.BIN" })], {
      compression: { store: [".BIN"] },
    });
    expect(p.entries[0]?.method).toBe("store");
  });

  it("accepts a store extension written without a leading dot", () => {
    const p = plan([scanEntry({ archivePath: "model.bin" })], {
      compression: { store: ["bin"] },
    });
    expect(p.entries[0]?.method).toBe("store");
  });

  it("always stores a directory entry regardless of compression policy", () => {
    const p = plan([scanEntry({ archivePath: "dir", type: "dir" })], {
      compression: { stored: "none" },
    });
    expect(p.entries[0]?.method).toBe("store");
  });
});

describe("zip64 verdict", () => {
  const huge = (): ScanEntry[] => [scanEntry({ archivePath: "big.bin", size: 5_000_000_000 })];

  it("uses and warns under auto when triggered", () => {
    const p = plan(huge(), { zip64: "auto" });
    expect(p.summary.zip64).toBe(true);
    expect(rules(p.findings)).toContain("compat.zip64");
    expect(p.writable).toBe(true);
  });

  it("errors under never when triggered", () => {
    const p = plan(huge(), { zip64: "never" });
    expect(p.summary.zip64).toBe(false);
    expect(rules(p.findings)).toContain("compat.zip64-required");
    expect(p.writable).toBe(false);
  });

  it("uses and warns under always even for a small archive", () => {
    const p = plan([scanEntry({ archivePath: "small.txt" })], { zip64: "always" });
    expect(p.summary.zip64).toBe(true);
    expect(rules(p.findings)).toContain("compat.zip64");
  });
});

describe("timestamps", () => {
  it("flags a pre-1980 modification time", () => {
    const p = plan([scanEntry({ archivePath: "old.txt", mtimeNs: 0n })]);
    expect(rules(p.findings)).toContain("time.pre-1980");
    expect(p.writable).toBe(true);
  });
});

describe("symlinks", () => {
  it("excludes a symlink under ignore with a warning", () => {
    const p = plan([scanEntry({ archivePath: "link", type: "symlink", linkTarget: "t" })]);
    expect(p.entries[0]?.excluded).toBe(true);
    expect(rules(p.findings)).toContain("entry.symlink");
  });

  it("keeps a symlink under preserve and writes it", () => {
    const p = plan([scanEntry({ archivePath: "link", type: "symlink", linkTarget: "t" })], {
      symlinks: "preserve",
    });
    expect(p.entries[0]?.excluded).toBe(false);
    expect(written(p)).toEqual(["link"]);
    expect(rules(p.findings)).toContain("entry.symlink");
  });
});

describe("traversal", () => {
  it("blocks a path that escapes the archive root", () => {
    const p = plan([scanEntry({ archivePath: "../escape.txt" })]);
    expect(p.writable).toBe(false);
    expect(rules(p.findings)).toContain("path.traversal");
    expect(p.entries[0]?.excluded).toBe(true);
  });
});

describe("output gate", () => {
  it("is not writable when the output exists without overwrite", () => {
    expect(plan([scanEntry({ archivePath: "a.txt" })], {}, { outputExists: true }).writable).toBe(
      false,
    );
  });

  it("is writable when overwrite is authorized", () => {
    const p = plan([scanEntry({ archivePath: "a.txt" })], {}, { outputExists: true, overwrite: true });
    expect(p.writable).toBe(true);
  });
});
