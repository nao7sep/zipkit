/**
 * Segment name-fixing table tests. Each row asserts the repaired segment and
 * which rules fired, in order, under the all-`fix` action set. The action
 * variants (warn/error/none) get their own block: each decides whether the fix
 * is applied and at what severity the issue is reported. These are paths a
 * filesystem walk seldom produces, so they are tested directly. Special
 * characters are constructed via code points to keep the source readable.
 */

import { describe, expect, it } from "vitest";
import { fullFixSegment, processSegment } from "../../src/plan/nameFix.js";
import type { RuleId } from "../../src/registry.js";
import type { NameRules } from "../../src/types.js";

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
    invalidCharStyle: "replace",
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
  { name: "suffixes COM0", input: "COM0", expected: "COM0_", rules: ["name.reserved"] },
  { name: "suffixes LPT0", input: "LPT0", expected: "LPT0_", rules: ["name.reserved"] },
  { name: "suffixes LPT9", input: "lpt9.log", expected: "lpt9_.log", rules: ["name.reserved"] },
  ...["\u00b9", "\u00b2", "\u00b3"].flatMap((sup): Row[] => [
    { name: `suffixes COM${sup}`, input: `COM${sup}`, expected: `COM${sup}_`, rules: ["name.reserved"] },
    { name: `suffixes LPT${sup}`, input: `LPT${sup}`, expected: `LPT${sup}_`, rules: ["name.reserved"] },
  ]),
  {
    name: "suffixes a lower-case superscript port with an extension",
    input: "com\u00b9.txt",
    expected: "com\u00b9_.txt",
    rules: ["name.reserved"],
  },
  { name: "suffixes CONIN$", input: "CONIN$", expected: "CONIN$_", rules: ["name.reserved"] },
  { name: "suffixes CONOUT$", input: "CONOUT$", expected: "CONOUT$_", rules: ["name.reserved"] },
  { name: "suffixes a lower-case conout$", input: "conout$", expected: "conout$_", rules: ["name.reserved"] },
  {
    name: "suffixes CONIN$ with an extension",
    input: "CONIN$.txt",
    expected: "CONIN$_.txt",
    rules: ["name.reserved"],
  },
  { name: "does not treat COM10 as reserved", input: "COM10", expected: "COM10", rules: [] },
  { name: "does not treat CONIN as reserved", input: "CONIN", expected: "CONIN", rules: [] },
  { name: "does not treat COM\u2074 as reserved", input: "COM\u2074", expected: "COM\u2074", rules: [] },
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

describe("invalid-character styles", () => {
  const fix = (input: string, invalidCharStyle: NameRules["invalidCharStyle"]) =>
    processSegment(input, { ...allFix(), invalidCharStyle }).segment;

  it("tidies runs: one replacement inside a word, dropped at either end of the name or beside a space", () => {
    expect(fix("How are you???.url", "tidy")).toBe("How are you.url");
    expect(fix("a:b.txt", "tidy")).toBe("a_b.txt");
    expect(fix("a::b", "tidy")).toBe("a_b");
    expect(fix("Re: plan <draft>.txt", "tidy")).toBe("Re plan draft.txt");
    expect(fix("a : b", "tidy")).toBe("a b");
    expect(fix("? hello", "tidy")).toBe("hello");
    expect(fix("file.t?t", "tidy")).toBe("file.t_t");
    // A name made only of them keeps one replacement rather than becoming a dot file.
    expect(fix("???.txt", "tidy")).toBe("_.txt");
    expect(fix("plain name.txt", "tidy")).toBe("plain name.txt");
  });

  it("treats any white space as a space, and never touches an underscore or a space the name had", () => {
    expect(fix("a:\u3000b", "tidy")).toBe("a\u3000b");
    expect(fix("a\u3000:\u3000b", "tidy")).toBe("a\u3000b");
    expect(fix("a\u00a0?", "tidy")).toBe("a");
    expect(fix("my_file  name.txt", "tidy")).toBe("my_file  name.txt");
    expect(fix("_a?b_.txt", "tidy")).toBe("_a_b_.txt");
    expect(fix("a _?b", "tidy")).toBe("a __b");
  });

  it("never uncovers a dot the name did not start with, nor leaves only dots", () => {
    expect(fix("?..txt", "tidy")).toBe("_..txt");
    expect(fix("<.>", "remove")).toBe("_");
    expect(fix("?.?", "remove")).toBe("_");
    expect(fix(".?", "remove")).toBe("_");
    // With trailing dots left alone by choice, the name keeps its dot, but is never only dots.
    expect(processSegment("<.>", { ...allFix(), invalidCharStyle: "remove", trailingDotSpace: "none" }).segment).toBe("_.");
    expect(processSegment(".<.", { ...allFix(), invalidCharStyle: "remove", trailingDotSpace: "none" }).segment).toBe("_");
  });

  it("replaces each one, uses the full-width look-alike, or removes them", () => {
    expect(fix("How are you???.url", "replace")).toBe("How are you___.url");
    expect(fix("How are you???.url", "fullwidth")).toBe("How are you\uff1f\uff1f\uff1f.url");
    expect(fix('<a>:"b"|c?*\\', "fullwidth")).toBe("\uff1ca\uff1e\uff1a\uff02b\uff02\uff5cc\uff1f\uff0a\uff3c");
    expect(fix("How are you???.url", "remove")).toBe("How are you.url");
    expect(fix("a:b.txt", "remove")).toBe("ab.txt");
    expect(fix("Re: plan <draft>.txt", "remove")).toBe("Re plan draft.txt");
  });

  it("records the fix as one invalid-character finding whatever the style", () => {
    for (const style of ["tidy", "replace", "fullwidth", "remove"] as const) {
      const result = processSegment("a:b", { ...allFix(), invalidCharStyle: style });
      expect(result.issues.map((issue) => issue.rule)).toEqual(["name.invalid-char"]);
    }
  });

  it("tidies by default", async () => {
    const { NAME_DEFAULTS } = await import("../../src/policy.js");
    expect(NAME_DEFAULTS.invalidCharStyle).toBe("tidy");
  });
});

describe("invalid-character styles never produce an unsafe name", () => {
  // A seeded generator, so every run checks the same names and a failure
  // reproduces exactly.
  function* names(seed: number, count: number): Generator<string> {
    const alphabet = ["a", "b", ".", " ", "\u3000", "_", "<", ">", ":", '"', "|", "?", "*", "\\"];
    let state = seed;
    const next = (): number => { state = (state * 1103515245 + 12345) % 2147483648; return state; };
    for (let i = 0; i < count; i++) {
      let name = "";
      const length = 1 + (next() % 8);
      for (let j = 0; j < length; j++) name += alphabet[next() % alphabet.length];
      yield name;
    }
  }

  it.each(["tidy", "replace", "fullwidth", "remove"] as const)("%s: never empty, a dot file it was not, only dots, or still invalid", (style) => {
    for (const name of names(20261017, 20000)) {
      for (const trailingDotSpace of ["fix", "none"] as const) {
        const out = processSegment(name, { ...allFix(), invalidCharStyle: style, trailingDotSpace }).segment;
        if (out === name) continue; // nothing to fix: the path pass judges the name as it came
        const at = `${JSON.stringify(name)} → ${JSON.stringify(out)} (${style}, trailing ${trailingDotSpace})`;
        expect(out, at).not.toBe("");
        expect(/^[.\s]+$/u.test(out), at).toBe(false);
        expect(/[<>:"|?*\\/]/.test(out), at).toBe(false);
        if (!name.startsWith(".")) expect(out.startsWith("."), at).toBe(false);
      }
    }
  });
});
