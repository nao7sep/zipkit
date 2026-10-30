/** What a typed whole-number field reads as a number, and what it refuses. */

import { describe, expect, it } from "vitest";
import { parseWholeNumber } from "../../../../src/gui/renderer/src/components/WholeNumberInput";

const LEVEL = { min: 1, max: 9 };

describe("parseWholeNumber", () => {
  it("reads whole numbers in range, as typed with spaces or full-width digits", () => {
    expect(parseWholeNumber("1", LEVEL)).toBe(1);
    expect(parseWholeNumber("09", LEVEL)).toBe(9);
    expect(parseWholeNumber(" 5 ", LEVEL)).toBe(5);
    expect(parseWholeNumber("５", LEVEL)).toBe(5);
    expect(parseWholeNumber("0", { min: 0, max: 100 })).toBe(0);
  });

  it("refuses empty text, fractions, signs, exponents, words and values out of range", () => {
    for (const text of ["", " ", "0", "10", "4.5", "4.", "+4", "-1", "1e0", "four", "4 5"]) {
      expect(parseWholeNumber(text, LEVEL), text).toBeNull();
    }
  });
});
