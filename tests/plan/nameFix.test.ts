/**
 * Segment name-fixing table tests. Each row asserts the repaired
 * segment and which registry rules fired, in order. These are paths a
 * filesystem walk seldom produces, so they are tested directly. Special
 * characters are constructed via code points to keep the source readable and
 * unambiguous.
 */

import { describe, expect, it } from "vitest";
import { fixSegment } from "../../src/plan/nameFix.js";
import type { RuleId } from "../../src/registry.js";

const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const NFD_E = `e${COMBINING_ACUTE}`;
const NFC_E = String.fromCodePoint(0x00e9);
const ZWSP = String.fromCodePoint(0x200b);
const BELL = String.fromCodePoint(0x07);

interface Row {
  name: string;
  input: string;
  expected: string;
  rules: RuleId[];
  replacement?: string;
}

const rows: Row[] = [
  { name: "leaves a clean name untouched", input: "report.txt", expected: "report.txt", rules: [] },
  { name: "normalizes NFD to NFC", input: `caf${NFD_E}`, expected: `caf${NFC_E}`, rules: ["name.nfd"] },
  {
    name: "substitutes Windows-invalid characters",
    input: "a:b*c?.txt",
    expected: "a_b_c_.txt",
    rules: ["name.invalid-char"],
  },
  { name: "substitutes a backslash", input: "a\\b", expected: "a_b", rules: ["name.invalid-char"] },
  {
    name: "strips control characters",
    input: `ab${BELL}c`,
    expected: "abc",
    rules: ["name.control-char"],
  },
  {
    name: "trims trailing dots and spaces",
    input: "name. . ",
    expected: "name",
    rules: ["name.trailing-dot-space"],
  },
  { name: "suffixes a bare reserved name", input: "CON", expected: "CON_", rules: ["name.reserved"] },
  {
    name: "suffixes a reserved name with an extension",
    input: "con.txt",
    expected: "con_.txt",
    rules: ["name.reserved"],
  },
  { name: "suffixes COM1", input: "COM1", expected: "COM1_", rules: ["name.reserved"] },
  { name: "does not treat COM0 as reserved", input: "COM0", expected: "COM0", rules: [] },
  {
    name: "flags suspicious zero-width characters but keeps them",
    input: `a${ZWSP}b`,
    expected: `a${ZWSP}b`,
    rules: ["name.suspicious"],
  },
  { name: "falls back to the replacement for an empty segment", input: "", expected: "_", rules: [] },
  {
    name: "falls back to the replacement when control stripping empties the segment",
    input: `${BELL}${BELL}`,
    expected: "_",
    rules: ["name.control-char"],
  },
  {
    name: "applies rules in registry order for a compound case",
    input: `${NFD_E}:x. `,
    expected: `${NFC_E}_x`,
    rules: ["name.nfd", "name.invalid-char", "name.trailing-dot-space"],
  },
  {
    name: "honors a custom replacement character",
    input: "a:b",
    expected: "a#b",
    rules: ["name.invalid-char"],
    replacement: "#",
  },
];

describe("fixSegment", () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = fixSegment(row.input, row.replacement ?? "_");
      expect(result.segment).toBe(row.expected);
      expect(result.rules).toEqual(row.rules);
    });
  }

  it("records a transformation chain for the metadata", () => {
    const result = fixSegment("a:b. ", "_");
    expect(result.transformations.map((t) => t.rule)).toEqual([
      "name.invalid-char",
      "name.trailing-dot-space",
    ]);
    expect(result.transformations[0]?.before).toBe("a:b. ");
    expect(result.transformations[0]?.after).toBe("a_b. ");
    expect(result.transformations[1]?.after).toBe("a_b");
  });
});
