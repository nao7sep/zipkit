import { describe, expect, it } from "vitest";
import { aliasUnprovable, foldedName } from "../../src/internal/name-equivalence.ts";

describe("aliasUnprovable", () => {
  it.each(["darwin", "linux", "win32"] as const)("treats non-ASCII names as unprovable on %s", (platform) => {
    expect(aliasUnprovable("café", platform)).toBe(true);
    expect(aliasUnprovable("notes.txt", platform)).toBe(false);
  });

  it.each(["PROGRA~1", "report.", "report "])("treats the Windows alias spelling %j as unprovable only on Windows", (name) => {
    expect(aliasUnprovable(name, "win32")).toBe(true);
    expect(aliasUnprovable(name, "darwin")).toBe(false);
    expect(aliasUnprovable(name, "linux")).toBe(false);
  });
});

describe("foldedName", () => {
  it("folds case and Unicode composition on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(foldedName("Café", platform)).toBe(foldedName("café", platform));
      expect(foldedName("README", platform)).toBe(foldedName("readme", platform));
      // The one case rule collisions use too: final sigma meets sigma, ß stays apart from ss.
      expect(foldedName("ΟΔΟΣ", platform)).toBe(foldedName("οδος", platform));
      expect(foldedName("Straße", platform)).not.toBe(foldedName("STRASSE", platform));
    }
  });

  it("drops trailing dots and spaces only on Windows", () => {
    expect(foldedName("Report. .", "win32")).toBe(foldedName("report", "win32"));
    expect(foldedName("Report. .", "darwin")).toBe(foldedName("report. .", "darwin"));
  });
});
