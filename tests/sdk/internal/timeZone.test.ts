import { afterEach, describe, expect, it, vi } from "vitest";

import { machineTimeZone } from "../../../src/sdk/internal/timeZone.js";

afterEach(() => vi.restoreAllMocks());

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
