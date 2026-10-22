/**
 * Every name and path rule held to its invariants over generated names, as
 * sdk-conventions asks of transformations: what the rules produce is valid on
 * every target, a fix never leaves something another rule must fix again, the
 * record of the fixes leads from the name found to the name written, a defect
 * left in place is always reported, and nothing two items had apart becomes
 * one silently. The generator is seeded, so every run checks the same names
 * and a failure reproduces exactly.
 *
 * What "valid on every target" means is written here from the targets'
 * documented rules (Windows' forbidden characters, device names and dropped
 * trailing dots and spaces; Unicode NFC), not taken from the code under test.
 */

import { describe, expect, it } from "vitest";
import { caseFold } from "../../src/internal/name-equivalence.ts";
import { checkOutputName } from "../../src/plan/outputName.ts";
import { planArchive } from "../../src/plan/plan.ts";
import { processSegment } from "../../src/plan/nameFix.ts";
import { fixPath } from "../../src/plan/pathFix.ts";
import { resolvePolicy } from "../../src/policy.ts";
import type { NameRules, RuleId } from "../../src/types.ts";
import { scanEntry, scanResult } from "../helpers/synthetic.ts";

// ---------------------------------------------------------------------------
// The targets' rules
// ---------------------------------------------------------------------------

/** Characters Windows forbids in a name, and the path separator. */
const FORBIDDEN = /[<>:"|?*\\/]/;
const CONTROL = /[\u0000-\u001f]/;
/** Windows' device names, by the stem before the first dot with trailing spaces dropped. */
const DEVICES = new Set([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3"].flatMap((d) => [`COM${d}`, `LPT${d}`]),
]);
const isDevice = (name: string): boolean => DEVICES.has(name.split(".")[0]!.replace(/ +$/, "").toUpperCase());

/** What is wrong with a name on some target, by the rule that repairs it. */
function defects(name: string): RuleId[] {
  const found: RuleId[] = [];
  if (name !== name.normalize("NFC")) found.push("name.nfd");
  if (/[<>:"|?*\\]/.test(name)) found.push("name.invalid-char");
  if (CONTROL.test(name)) found.push("name.control-char");
  if (/[ .]$/.test(name)) found.push("name.trailing-dot-space");
  if (isDevice(name)) found.push("name.reserved");
  return found;
}

/** A name every target holds as written: not empty, not only dots or white
 *  space, and free of every defect. */
function holdsEverywhere(name: string): boolean {
  return name !== "" && !/^[.\s]+$/u.test(name) && !FORBIDDEN.test(name) && defects(name).length === 0;
}

// ---------------------------------------------------------------------------
// Generated names
// ---------------------------------------------------------------------------

const COMBINING_ACUTE = "\u0301";
/** Pieces names are built from: letters in both cases, an NFD and an NFC é,
 *  every forbidden character, control characters, dots, spaces (the
 *  full-width one too), device-name stems, a zero-width space, Greek sigma in
 *  its forms, ß, and an extension. */
const PIECES = [
  "a", "A", "b", "B", `e${COMBINING_ACUTE}`, "\u00e9", "\u00c9",
  "<", ">", ":", '"', "|", "?", "*", "\\",
  "\u0001", "\u001f",
  ".", "..", " ", "\u3000", "_",
  "CON", "con", "Lpt1", "COM\u00b9", "CONIN$", "nul",
  "\u200b",
  "\u03c3", "\u03c2", "\u03a3",
  "\u00df", "SS", "ss",
  ".txt", ".TXT",
];

/** A seeded linear congruential generator, so every run sees the same values. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
}

function* names(seed: number, count: number, maxPieces = 6): Generator<string> {
  const next = random(seed);
  for (let i = 0; i < count; i++) {
    let name = "";
    const length = 1 + (next() % maxPieces);
    for (let j = 0; j < length; j++) name += PIECES[next() % PIECES.length];
    yield name;
  }
}

const STYLES = ["tidy", "replace", "fullwidth", "remove"] as const;

function allFix(style: NameRules["invalidCharStyle"]): NameRules {
  return { ...resolvePolicy().names, invalidCharStyle: style };
}

// ---------------------------------------------------------------------------
// One name
// ---------------------------------------------------------------------------

describe("a name every rule fixes", () => {
  it.each(STYLES)("%s: is held on every target, needs no second fix, and records each step from the name found to the name written", (style) => {
    const rules = allFix(style);
    for (const name of names(20261022, 20_000)) {
      const at = `${JSON.stringify(name)} (${style})`;
      const fixed = processSegment(name, rules);
      if (fixed.segment === name) {
        // Nothing to fix: such a name came in only dots or white space, which
        // the path pass judges, or it needs nothing on any target.
        expect(defects(name), at).toEqual([]);
        continue;
      }
      expect(holdsEverywhere(fixed.segment), `${at} → ${JSON.stringify(fixed.segment)}`).toBe(true);
      // A fix never produces what another rule must fix again.
      const again = processSegment(fixed.segment, rules);
      expect(again.segment, at).toBe(fixed.segment);
      expect(again.nameFixes, at).toEqual([]);
      // The recorded fixes chain from the name found to the name written.
      expect(fixed.nameFixes.length, at).toBeGreaterThan(0);
      expect(fixed.nameFixes[0]!.before, at).toBe(name);
      for (let i = 1; i < fixed.nameFixes.length; i++) expect(fixed.nameFixes[i]!.before, at).toBe(fixed.nameFixes[i - 1]!.after);
      expect(fixed.nameFixes.at(-1)!.after, at).toBe(fixed.segment);
      // Every fix is reported, and nothing is left to report.
      expect(fixed.issues.filter((i) => i.applied).map((i) => i.rule), at).toEqual(fixed.nameFixes.map((f) => f.rule));
    }
  });

  it("never leaves a defect unreported when a rule is told to warn, fail or keep quiet instead", () => {
    const actions = ["fix", "warn", "error", "none"] as const;
    const next = random(1022);
    for (const name of names(10_22, 20_000)) {
      const pick = () => actions[next() % actions.length]!;
      const rules: NameRules = {
        ...allFix(STYLES[next() % STYLES.length]!),
        nfc: pick(), invalidChars: pick(), controlChars: pick(), trailingDotSpace: pick(), reserved: pick(),
      };
      const action: Partial<Record<RuleId, string>> = {
        "name.nfd": rules.nfc, "name.invalid-char": rules.invalidChars, "name.control-char": rules.controlChars,
        "name.trailing-dot-space": rules.trailingDotSpace, "name.reserved": rules.reserved,
      };
      const fixed = processSegment(name, rules);
      const at = `${JSON.stringify(name)} → ${JSON.stringify(fixed.segment)} ${JSON.stringify(action)}`;
      for (const rule of defects(fixed.segment)) {
        // A defect still in the name is one its rule was told not to fix, and
        // it is reported at that rule's tier unless told to keep quiet.
        expect(action[rule], `${at}: ${rule} left`).not.toBe("fix");
        const reported = fixed.issues.find((i) => i.rule === rule);
        if (action[rule] === "none") expect(reported, at).toBeUndefined();
        else expect(reported?.severity, `${at}: ${rule}`).toBe(action[rule] === "warn" ? "warning" : "error");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The archive's own name
// ---------------------------------------------------------------------------

describe("the archive's own name", () => {
  it.each(STYLES)("%s: an inferred one is held on every target and keeps .zip; a given one is never changed", (style) => {
    const rules = allFix(style);
    for (const stem of names(2026_10, 5_000)) {
      const output = `/out/${stem}.zip`;
      if (stem.includes("/") || stem === "" ) continue;
      const inferred = checkOutputName(output, true, rules);
      const name = inferred.path.slice("/out/".length);
      expect(name.endsWith(".zip"), JSON.stringify(stem)).toBe(true);
      const fixedStem = name.slice(0, -".zip".length);
      if (fixedStem !== stem) expect(holdsEverywhere(fixedStem), `${JSON.stringify(stem)} → ${JSON.stringify(fixedStem)}`).toBe(true);
      const given = checkOutputName(output, false, rules);
      expect(given.path, JSON.stringify(stem)).toBe(output);
      if (defects(stem).length > 0) expect(given.issues.length, JSON.stringify(stem)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Whole paths
// ---------------------------------------------------------------------------

describe("a path", () => {
  it("is rooted inside the archive or refused, whatever prefix or parent steps it carries", () => {
    const next = random(22);
    const parts = ["a", "b", "..", ".", "", "C:", "c:", "x"];
    for (let i = 0; i < 20_000; i++) {
      const length = 1 + (next() % 6);
      const segments = Array.from({ length }, () => parts[next() % parts.length]!);
      const lead = ["", "/", "//", "C:/", "c:/"][next() % 5]!;
      const input = lead + segments.join("/");
      const at = JSON.stringify(input);
      const result = fixPath(input);
      if (result.escaped) continue;
      expect(result.path.startsWith("/"), at).toBe(false);
      expect(/^[A-Za-z]:\//.test(result.path), at).toBe(false);
      expect(result.path.split("/").some((s) => s === ".." || s === "."), at).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Siblings
// ---------------------------------------------------------------------------

describe("names in one folder", () => {
  it.each(STYLES)("%s: two items never become one entry silently, and every entry written is held on every target", (style) => {
    const next = random(2210);
    const generated = names(221022, 4_000, 3);
    let collisions = 0;
    for (let folder = 0; folder < 400; folder++) {
      // A case-sensitive file system holds any set of distinct names. Most
      // siblings are variants of one name, as merges come from: case, NFD,
      // a forbidden character for another, a trailing dot or space.
      const base = generated.next().value as string;
      const variants = [
        base, base.toUpperCase(), base.toLowerCase(), base.normalize("NFD"),
        base.replace(/[<>:"|?*\\]/g, "_"), base.replace(/_/g, ":"), `${base}.`, `${base} `, `${base}?`,
      ];
      const siblings = new Set<string>();
      const count = 2 + (next() % 6);
      for (let i = 0; i < count; i++) siblings.add(next() % 4 === 0 ? generated.next().value as string : variants[next() % variants.length]!);
      const entries = [...siblings].filter((name) => !/^[.\s]+$/u.test(name) && !name.includes("/"))
        .map((name) => scanEntry({ archivePath: `in/${name}` }));
      const plan = planArchive(scanResult(entries), resolvePolicy(undefined, { names: { invalidCharStyle: style }, exclusions: [] }));
      const included = plan.entries.filter((e) => !e.excluded && e.archivePath !== "in");
      const at = JSON.stringify([...siblings]);

      for (const entry of included) {
        for (const segment of entry.archivePath.split("/")) {
          if (segment !== entry.originalPath.split("/").at(-1)) expect(holdsEverywhere(segment), `${at}: ${JSON.stringify(entry.archivePath)}`).toBe(true);
        }
      }
      // Items whose written paths fold together on a case-insensitive file
      // system are each marked as colliding, which blocks the write.
      const byFold = new Map<string, typeof included>();
      for (const entry of included) byFold.set(caseFold(entry.archivePath), [...(byFold.get(caseFold(entry.archivePath)) ?? []), entry]);
      for (const group of byFold.values()) {
        if (group.length < 2) continue;
        collisions++;
        for (const entry of group) {
          expect(entry.findings.some((f) => f.rule.startsWith("collision.") && f.severity === "error"), `${at}: ${entry.originalPath}`).toBe(true);
        }
        expect(plan.writable, at).toBe(false);
      }
    }
    // The generated folders do hold names that fold together.
    expect(collisions).toBeGreaterThan(10);
  });
});
