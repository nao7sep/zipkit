import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/gui/renderer/src/index.css"), "utf8");
const compact = css.replace(/\s+/g, "");

const rule = (selector: string): string => {
  const start = compact.indexOf(`${selector}{`);
  expect(start, `Missing state rule: ${selector}`).toBeGreaterThanOrEqual(0);
  return compact.slice(start + selector.length + 1, compact.indexOf("}", start));
};

// These pin the CSS roles when states coincide; they do not prove rendered
// contrast or the browser's native pointer/keyboard :focus-visible heuristics.
describe("independent composite visual states", () => {
  it.each([".menu-item", ".job-row", ".records-row"])("keeps %s keyboard focus separate from hover and selection", (role) => {
    expect(rule(`${role}:focus-visible`)).toMatch(/outline:[^;]*solidvar\(--accent-strong\)/);
    expect(rule(`${role}:focus-visible`)).toMatch(/outline-offset:-\d+px/);
    expect(rule(`[data-window-inactive]${role}:focus-visible`)).toContain("outline-color:var(--border)");
    for (const hover of role === ".records-row" ? [".records-row:not(.records-row--selected):hover", ".records-row--selected:hover"] : [`${role}:hover`]) {
      const hoverRule = rule(hover);
      expect(hoverRule).toContain("background:");
      expect(hoverRule).not.toMatch(/outline|border|box-shadow/);
    }
  });

  it("steps selected Records hover without replacing its selection border", () => {
    expect(rule(".records-row--selected")).toContain("border-color:var(--accent-strong)");
    const background = (selector: string) => rule(selector).match(/background:([^;]+)/)?.[1];
    expect(background(".records-row--selected:hover")).not.toBe(background(".records-row--selected"));
    expect(rule(".records-row--selected:hover")).toContain("var(--accent-strong)");
  });

  it("retains job status color through hover and leaves pointer-open menu targets visually quiet", () => {
    expect(rule(".job-row:hover")).toContain("var(--job-tint)");
    expect(compact).not.toContain(".menu-item[data-highlighted]");
  });
});

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

// Truncation draws one marker (interface-styling, text-cleanup and
// responsive-interface conventions): a new text-overflow site must be added here
// deliberately, and nothing may clip one-line text without a marker. Visually
// hidden screen-reader text (clip/clipPath) is not truncation.
describe("truncation sites", () => {
  const rules = [...compact.replace(/\/\*.*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!, body: body! }));
  const sources = (dir: string): string[] => readdirSync(resolve(dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".tsx")).map((name) => resolve(dir, name));
  const styleBlocks = sources("src/gui/renderer/src").flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(\w+): \{([^{}]*)\}/g)].map(([, name, body]) => ({ at: `${basename(file)} ${name}`, body: body! })));

  it("draws markers only at the reviewed sites", () => {
    // Identifying text shortens through the shared one-line and path classes;
    // a menu command and a closed select carry their own marker.
    expect(rules.filter((rule) => rule.body.includes("text-overflow:")).map((rule) => rule.selector))
      .toEqual(["select", ".text-line", ".path-line__head,.path-line__tail", ".menu-item"]);
    expect(styleBlocks.filter((block) => block.body.includes("textOverflow")).map((block) => block.at)).toEqual(["Pane.tsx title"]);
  });

  it("never clips one-line text without a marker", () => {
    const silentCss = rules.filter(({ body }) =>
      body.includes("white-space:nowrap") && /overflow(-x)?:(hidden|clip)/.test(body) && !body.includes("text-overflow:ellipsis"));
    expect(silentCss.map((rule) => rule.selector)).toEqual([]);
    const silentInline = styleBlocks.filter(({ body }) =>
      /whiteSpace: "nowrap"/.test(body) && /overflow(X)?: "(hidden|clip)"/.test(body) && !/textOverflow: "ellipsis"|clip(Path)?:/.test(body));
    expect(silentInline.map((block) => block.at)).toEqual([]);
  });
});

// The shared path line keeps the final segment: its head gives up width first.
describe("path line", () => {
  it("shrinks only the head while the final segment fits, so a path shows one marker", () => {
    // The last rule for each part is its own; the first is the one they share.
    const shrink = (selector: string) => {
      const start = compact.lastIndexOf(`}${selector}{`) + selector.length + 2;
      return Number(compact.slice(start, compact.indexOf("}", start)).match(/flex:0(\d+)auto/)?.[1]);
    };
    expect(shrink(".path-line__head")).toBeGreaterThan(0);
    expect(shrink(".path-line__tail")).toBe(0);
    expect(compact).toMatch(/\.path-line__tail\{[^}]*max-width:100%/);
  });
});

// A row's icon action is compact, so a list's rows read as items rather than
// stacked controls, yet never smaller than a pointer comfortably hits.
describe("compact role", () => {
  it("is smaller than a standard control and at least 22 px square", () => {
    const compactRule = rule("button.icon.compact");
    const size = (prop: string) => Number(compactRule.match(new RegExp(`(?:^|;)${prop}:(\\d+)px`))?.[1]);
    expect(size("height")).toBeGreaterThanOrEqual(22);
    expect(size("width")).toBeGreaterThanOrEqual(22);
    expect(size("height")).toBeLessThan(Number(compact.match(/--control-h:(\d+)px/)?.[1]));
  });
});
