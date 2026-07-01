/**
 * Unit tests for the pure change decision and fold-collision resolution (no filesystem). Change is
 * size + mtime with a 2-second tolerance; a fold-collision keeps one candidate and skips the rest.
 */

import { describe, expect, it } from "vitest";
import {
  MTIME_MATCH_TOLERANCE_MS,
  dedupeFoldCollisions,
  selectChanged,
} from "../../../../src/gui/main/backup/backupPlan.js";
import type { BackupCandidate, BackupIndex } from "../../../../src/gui/main/backup/backupTypes.js";

const candidate = (over: Partial<BackupCandidate> = {}): BackupCandidate => ({
  sourcePath: "/abs/config.json",
  archivePath: "config.json",
  sizeBytes: 100,
  mtimeMs: 1_700_000_000_000,
  ...over,
});

const indexOf = (...entries: BackupIndex["entries"]): BackupIndex => ({ entries });

describe("selectChanged", () => {
  it("treats a candidate with no prior entry as new", () => {
    expect(selectChanged([candidate()], indexOf())).toHaveLength(1);
  });

  it("skips a candidate whose size and mtime match the latest entry", () => {
    const c = candidate();
    const index = indexOf({
      archivedAt: "20260101-000000-utc",
      archivePath: c.archivePath,
      sizeBytes: c.sizeBytes,
      lastWriteUtc: new Date(c.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    expect(selectChanged([c], index)).toEqual([]);
  });

  it("captures when the size differs", () => {
    const c = candidate({ sizeBytes: 200 });
    const index = indexOf({
      archivedAt: "20260101-000000-utc",
      archivePath: c.archivePath,
      sizeBytes: 100,
      lastWriteUtc: new Date(c.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    expect(selectChanged([c], index)).toHaveLength(1);
  });

  it("treats an mtime within the tolerance as unchanged, but beyond it as changed", () => {
    const base = 1_700_000_000_000;
    const iso = new Date(base).toISOString().replace(/\.\d{3}Z$/, "Z");
    const entry = { archivedAt: "20260101-000000-utc", archivePath: "config.json", sizeBytes: 100, lastWriteUtc: iso };

    const withinTol = candidate({ mtimeMs: base + MTIME_MATCH_TOLERANCE_MS });
    expect(selectChanged([withinTol], indexOf(entry))).toEqual([]);

    const beyondTol = candidate({ mtimeMs: base + MTIME_MATCH_TOLERANCE_MS + 1 });
    expect(selectChanged([beyondTol], indexOf(entry))).toHaveLength(1);
  });

  it("recaptures when the recorded timestamp cannot be parsed", () => {
    const c = candidate();
    const index = indexOf({
      archivedAt: "20260101-000000-utc",
      archivePath: c.archivePath,
      sizeBytes: c.sizeBytes,
      lastWriteUtc: "not-a-date",
    });
    expect(selectChanged([c], index)).toHaveLength(1);
  });

  it("compares against the latest entry per path (max archivedAt wins)", () => {
    const c = candidate({ sizeBytes: 100 });
    const index = indexOf(
      { archivedAt: "20260101-000000-utc", archivePath: "config.json", sizeBytes: 999, lastWriteUtc: "not-a-date" },
      {
        archivedAt: "20260201-000000-utc",
        archivePath: "config.json",
        sizeBytes: 100,
        lastWriteUtc: new Date(c.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    );
    expect(selectChanged([c], index)).toEqual([]);
  });
});

describe("dedupeFoldCollisions", () => {
  it("keeps all when there is no collision", () => {
    const cs = [candidate({ archivePath: "config.json" }), candidate({ archivePath: "queue.json" })];
    const { kept, skips } = dedupeFoldCollisions(cs);
    expect(kept).toHaveLength(2);
    expect(skips).toEqual([]);
  });

  it("keeps the first and skips a case-only-different path", () => {
    const cs = [candidate({ archivePath: "Config.json" }), candidate({ archivePath: "config.json" })];
    const { kept, skips } = dedupeFoldCollisions(cs);
    expect(kept.map((c) => c.archivePath)).toEqual(["Config.json"]);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.path).toBe("config.json");
    expect(skips[0]?.reason).toContain("Config.json");
  });
});
