/**
 * Unit tests for the pure home-root exclude list: config.json and queue.json are captured; layout.json,
 * logs/, backups/, *.tmp, and the noise files are excluded (data-backup conventions + zipkit specifics).
 */

import { describe, expect, it } from "vitest";
import { isExcludedDir, isExcludedFile } from "../../../../src/gui/main/backup/homeRootExclusions.js";

describe("isExcludedFile", () => {
  it("keeps the managed durable files", () => {
    expect(isExcludedFile("config.json")).toBe(false);
    expect(isExcludedFile("queue.json")).toBe(false);
  });

  it("excludes volatile layout.json", () => {
    expect(isExcludedFile("layout.json")).toBe(true);
    expect(isExcludedFile("Layout.json")).toBe(true);
  });

  it("excludes the feature's own output and recreatable logs", () => {
    expect(isExcludedFile("backups/index.json")).toBe(true);
    expect(isExcludedFile("backups/backup-x.zip")).toBe(true);
    expect(isExcludedFile("logs/20260101-000000-utc.log")).toBe(true);
  });

  it("excludes atomic-write temporaries and the fleet noise files anywhere", () => {
    expect(isExcludedFile("config-3f9c2b1e-4a7d-4c8b-9e2f-1a3b5c6d7e8f.tmp")).toBe(true);
    expect(isExcludedFile(".DS_Store")).toBe(true);
    expect(isExcludedFile("sub/.DS_Store")).toBe(true);
    expect(isExcludedFile("Thumbs.db")).toBe(true);
    expect(isExcludedFile("desktop.ini")).toBe(true);
    expect(isExcludedFile("Desktop.ini")).toBe(true); // matched case-insensitively
  });

  it("excludes quarantined-corrupt files anywhere, matched case-insensitively", () => {
    expect(isExcludedFile("config-20260705-121314-123-utc.invalid")).toBe(true);
    expect(isExcludedFile("CONFIG-20260705-121314-123-UTC.INVALID")).toBe(true); // all-caps variant
    expect(isExcludedFile("sub/queue-20260705-121314-123-utc.invalid")).toBe(true);
  });

  it("does not exclude a file whose name merely contains an excluded token", () => {
    expect(isExcludedFile("logszilla.json")).toBe(false);
    expect(isExcludedFile("my-layout.json")).toBe(false);
  });
});

describe("isExcludedDir", () => {
  it("prunes logs/ and backups/ case-insensitively, descends everything else", () => {
    expect(isExcludedDir("logs")).toBe(true);
    expect(isExcludedDir("Backups")).toBe(true);
    expect(isExcludedDir("data")).toBe(false);
  });
});
