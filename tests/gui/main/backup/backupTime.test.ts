/**
 * Unit tests for the whole-second UTC time helpers and the archive-run stamp.
 */

import { describe, expect, it } from "vitest";
import {
  formatArchivedAt,
  toIsoSeconds,
  truncateToSecondMs,
} from "../../../../src/gui/main/backup/backupTime.js";

describe("toIsoSeconds", () => {
  it("drops sub-second precision to a whole-second Z stamp", () => {
    expect(toIsoSeconds(Date.parse("2026-07-01T02:22:20.789Z"))).toBe("2026-07-01T02:22:20Z");
  });
});

describe("truncateToSecondMs", () => {
  it("floors to the whole second in milliseconds", () => {
    expect(truncateToSecondMs(1_700_000_000_789)).toBe(1_700_000_000_000);
  });
});

describe("formatArchivedAt", () => {
  it("produces the yyyymmdd-hhmmss-fff-utc filename stamp", () => {
    expect(formatArchivedAt(new Date("2026-07-01T02:22:20.500Z"))).toBe("20260701-022220-500-utc");
  });
});
