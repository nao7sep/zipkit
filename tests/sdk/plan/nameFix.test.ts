/**
 * Segment name-fixing table tests. Each row asserts the repaired segment and
 * which rules fired, in order, under the all-`fix` action set. The action
 * variants (warn/error/none) get their own block: each decides whether the fix
 * is applied and at what severity the issue is reported. These are paths a
 * filesystem walk seldom produces, so they are tested directly. Special
 * characters are constructed via code points to keep the source readable.
 */

import { describe, expect, it } from "vitest";
import { fullFixSegment, processSegment } from "../../../src/sdk/plan/nameFix.js";
import type { RuleId } from "../../../src/sdk/registry.js";
import type { NameRules } from "../../../src/sdk/types.js";

const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const NFD_E = `e${COMBINING_ACUTE}`;
const NFC_E = String.fromCodePoint(0x00e9);
const ZWSP = String.fromCodePoint(0x200b);
const BELL = String.fromCodePoint(0x07);

/** Every guardrail set to `fix` (suspicious to `warn`, its strongest action). */
function allFix(replacement = "_"): NameRules {
  return {
    nfc: "fix",
    invalidChars: "fix",
    invalidCharReplacement: replacement,
    controlChars: "fix",
    trailingDotSpace: "fix",
    reserved: "fix",
    suspicious: "warn",
  };
}

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

describe("processSegment (all fix)", () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = processSegment(row.input, allFix(row.replacement ?? "_"));
      expect(result.segment).toBe(row.expected);
      expect(result.issues.map((i) => i.rule)).toEqual(row.rules);
    });
  }

  it("records a transformation chain for the metadata", () => {
    const result = processSegment("a:b. ", allFix());
    expect(result.transformations.map((t) => t.rule)).toEqual([
      "name.invalid-char",
      "name.trailing-dot-space",
    ]);
    expect(result.transformations[0]?.before).toBe("a:b. ");
    expect(result.transformations[0]?.after).toBe("a_b. ");
    expect(result.transformations[1]?.after).toBe("a_b");
  });

  it("a fix issue is info severity and applied", () => {
    const [issue] = processSegment("a:b", allFix()).issues;
    expect(issue).toMatchObject({ rule: "name.invalid-char", severity: "info", applied: true });
  });
});

describe("processSegment actions", () => {
  it("warn leaves the name and reports a warning", () => {
    const result = processSegment("a:b", { ...allFix(), invalidChars: "warn" });
    expect(result.segment).toBe("a:b");
    expect(result.transformations).toEqual([]);
    expect(result.issues).toEqual([
      { rule: "name.invalid-char", severity: "warning", applied: false },
    ]);
  });

  it("error leaves the name and reports an error", () => {
    const result = processSegment("a:b", { ...allFix(), invalidChars: "error" });
    expect(result.segment).toBe("a:b");
    expect(result.issues).toEqual([
      { rule: "name.invalid-char", severity: "error", applied: false },
    ]);
  });

  it("none leaves the name and reports nothing", () => {
    const result = processSegment("a:b", { ...allFix(), invalidChars: "none" });
    expect(result.segment).toBe("a:b");
    expect(result.issues).toEqual([]);
  });

  it("suspicious can be silenced with none", () => {
    const result = processSegment(`a${ZWSP}b`, { ...allFix(), suspicious: "none" });
    expect(result.segment).toBe(`a${ZWSP}b`);
    expect(result.issues).toEqual([]);
  });

  it("only the fixed classes act when actions are mixed", () => {
    // NFD fixed, invalid chars left as a warning, trailing trimmed.
    const result = processSegment(`${NFD_E}:x. `, {
      ...allFix(),
      invalidChars: "warn",
    });
    expect(result.segment).toBe(`${NFC_E}:x`);
    expect(result.issues.map((i) => [i.rule, i.severity, i.applied])).toEqual([
      ["name.nfd", "info", true],
      ["name.invalid-char", "warning", false],
      ["name.trailing-dot-space", "info", true],
    ]);
  });
});

describe("fullFixSegment", () => {
  it("equals the input for a clean name", () => {
    expect(fullFixSegment("report.txt", "_")).toBe("report.txt");
  });

  it("returns the fully repaired segment", () => {
    expect(fullFixSegment("a:b. ", "_")).toBe("a_b");
  });
});
