import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/gui/renderer/src/index.css"), "utf8");
const compact = css.replace(/\s+/g, "");

describe("renderer scrollbar contract", () => {
  it("keeps a 16px gutter around a 10px inset thumb", () => {
    expect(compact).toMatch(/\*::-webkit-scrollbar\{[^}]*width:16px;[^}]*height:16px/);
    expect(compact).toMatch(/\*::-webkit-scrollbar-thumb\{[^}]*border:3pxsolidtransparent/);
    expect(compact).toContain("scrollbar-width:auto");
  });

  it("uses a readable owned token and strengthens the whole owner in use", () => {
    expect(compact).toContain("--scrollbar-thumb:#737b68");
    expect(compact).toContain("--scrollbar-thumb-active:var(--text-2)");
    expect(compact).toContain("*:hover::-webkit-scrollbar-thumb");
    expect(compact).toContain("*:focus-within::-webkit-scrollbar-thumb");
    expect(compact).toContain("scrollbar-gutter:stable");
  });
});
