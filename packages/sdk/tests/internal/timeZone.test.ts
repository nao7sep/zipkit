import { afterEach, describe, expect, it, vi } from "vitest";

import { instantFromWallClockInZone, machineTimeZone } from "../../src/internal/timeZone.js";

afterEach(() => vi.restoreAllMocks());

describe("wall clock restoration", () => {
  it.each([
    [{ year: 2024, month: 3, day: 10, hour: 3, minute: 30, second: 0 }, "2024-03-10T07:30:00.000Z"],
    [{ year: 2024, month: 11, day: 3, hour: 2, minute: 30, second: 0 }, "2024-11-03T07:30:00.000Z"],
  ] as const)("restores an unambiguous time after a daylight-saving change: %j", (clock, expected) => {
    expect(new Date(instantFromWallClockInZone(clock, "America/New_York")).toISOString()).toBe(expected);
  });
});

function reportZone(timeZone: string | undefined): void {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
  });
}

describe("machineTimeZone", () => {
  it("is the zone the platform reports", () => {
    reportZone("Asia/Tokyo");
    expect(machineTimeZone()).toBe("Asia/Tokyo");
  });

  it.each([undefined, ""])("falls back to UTC when the platform reports none: %j", (zone) => {
    reportZone(zone);
    expect(machineTimeZone()).toBe("UTC");
  });
});
