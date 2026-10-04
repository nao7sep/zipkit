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
    expect(compact).toContain("--scrollbar-thumb:#7d826c");
    expect(compact).toContain("--scrollbar-thumb:#737b68");
    expect(compact).toContain("--scrollbar-thumb-active:var(--text-2)");
    expect(compact).toContain("*:hover::-webkit-scrollbar-thumb");
    expect(compact).toContain("*:focus-within::-webkit-scrollbar-thumb");
    expect(compact).toContain("scrollbar-gutter:stable");
  });
});

// A button that does not answer a click reads as one that did nothing, so the
// action behind it gets reported as slow. Every role states its own pressed step:
// a role that leaves it unsaid does not fall back to a sensible default here,
// because the generic `button:active` rule outranks a variant's resting rule and
// would put the neutral utility step on a marigold or a red button.
describe("button pressed states", () => {
  it.each(["button", "button.accent", "button.danger", "button.danger-confirm", "button.icon"])(
    "gives %s a pressed step of its own",
    (role) => {
      expect(compact).toContain(`${role}:active:not(:disabled){`);
    },
  );

  // Off, every button is its resting self faded, at the one value the app states.
  it("fades a disabled button instead of restyling it", () => {
    expect(compact).toMatch(/button:disabled\{opacity:0\.45/);
  });
});

// The options grid sizes its columns from the pane, never below one column's
// worth of content, so a section is never squeezed until its rows overlap.
describe("options grid", () => {
  it("fits as many columns as the pane holds, each at least one section wide or the whole pane", () => {
    expect(compact).toMatch(/\.options-grid\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,\d+(\.\d+)?rem\),1fr\)\)/);
    expect(compact).not.toContain("@container");
  });
});
