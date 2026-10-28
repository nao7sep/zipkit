import { describe, expect, it } from "vitest";
import { caseFold } from "../../src/internal/name-equivalence.ts";

describe("caseFold", () => {
  it("folds case and Unicode composition", () => {
    expect(caseFold("Café")).toBe(caseFold("café".normalize("NFD")));
    expect(caseFold("README")).toBe(caseFold("readme"));
    // Final sigma meets sigma, ß stays apart from ss.
    expect(caseFold("ΟΔΟΣ")).toBe(caseFold("οδος"));
    expect(caseFold("Straße")).not.toBe(caseFold("STRASSE"));
  });
});
