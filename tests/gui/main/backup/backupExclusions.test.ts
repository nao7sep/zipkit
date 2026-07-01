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
    expect(isExcludedFile("config.json.tmp")).toBe(true);
    expect(isExcludedFile(".DS_Store")).toBe(true);
    expect(isExcludedFile("sub/.DS_Store")).toBe(true);
    expect(isExcludedFile("Thumbs.db")).toBe(true);
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
