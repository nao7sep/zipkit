import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Every color pair the renderer draws keeps high contrast in both themes,
// by this app's own floor: 4.5:1 for text, 3:1 for a text field's
// outline, the focus and selection ring, and the scroll-bar thumb. Light tokens
// live in index.css's top-level :root block; dark tokens in the :root block
// inside @media (prefers-color-scheme: dark). A status badge sits on a job row
// tinted with its own status and adds its own tint, so status text is checked
// over that double tint too.
const css = readFileSync(resolve("src/gui/renderer/src/index.css"), "utf8");

type Rgb = [number, number, number];

function themeBlock(theme: "light" | "dark"): string {
  if (theme === "light") {
    const start = css.search(/^:root\s*\{/m);
    return css.slice(css.indexOf("{", start), css.indexOf("\n}", start));
  }
  const media = css.indexOf("@media (prefers-color-scheme: dark) {");
  expect(media, "the dark theme must be a prefers-color-scheme block").toBeGreaterThanOrEqual(0);
  const start = css.indexOf("  :root {", media);
  return css.slice(css.indexOf("{", start), css.indexOf("\n  }", start));
}

function hexOf(block: string, token: string): Rgb {
  const value = block.match(new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "i"))?.[1];
  expect(value, `${token} must be an opaque six-digit hex color`).toBeTruthy();
  return [1, 3, 5].map((offset) => Number.parseInt(value!.slice(offset, offset + 2), 16)) as Rgb;
}

function mix(color: Rgb, base: Rgb, amount: number): Rgb {
  return color.map((channel, index) => channel * amount + base[index]! * (1 - amount)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ["--bg", "--surface", "--surface-2"];
const STATUSES = ["error", "warning", "ok", "info", "busy", "queued", "ready", "idle"].map((status) => `--status-${status}`);

describe("theme token contrast", () => {
  for (const theme of ["light", "dark"] as const) describe(`${theme} theme`, () => {
    const block = themeBlock(theme);
    // Collects every shortfall so one run lists them all.
    let failures: string[] = [];
    const check = (ink: Rgb, background: Rgb, floor: number, label: string) => {
      const ratio = contrast(ink, background);
      if (ratio < floor) failures.push(`${label}: ${ratio.toFixed(2)}`);
    };
    beforeEach(() => {
      failures = [];
    });
    afterEach(() => {
      expect(failures.join("\n"), `pairs below the floor in ${theme}`).toBe("");
    });

    it("keeps body and secondary text at 4.5:1 or more", () => {
      for (const ink of ["--text", "--text-2"]) {
        for (const surface of SURFACES) check(hexOf(block, ink), hexOf(block, surface), 4.5, `${ink} on ${surface}`);
      }
      for (const control of ["--utility", "--utility-hover"]) {
        check(hexOf(block, "--text"), hexOf(block, control), 4.5, `--text on ${control}`);
      }
      check(hexOf(block, "--accent-ink"), hexOf(block, "--accent"), 4.5, "--accent-ink on --accent");
      check(hexOf(block, "--accent-ink"), hexOf(block, "--accent-hover"), 4.5, "--accent-ink on --accent-hover");
      for (const fill of ["--danger", "--danger-hover"]) check([255, 255, 255], hexOf(block, fill), 4.5, `white on ${fill}`);
    });

    it("keeps status text at 4.5:1 or more, on its own tint and on a status-tinted row", () => {
      for (const status of STATUSES) {
        const color = hexOf(block, status);
        for (const surface of SURFACES) check(color, hexOf(block, surface), 4.5, `${status} on ${surface}`);
        check(color, mix(color, hexOf(block, "--surface"), 0.26), 4.5, `${status} badge on its tinted row`);
        check(hexOf(block, "--text"), mix(color, hexOf(block, "--surface-2"), 0.1), 4.5, `--text on a ${status} notice`);
      }
    });

    // Destructive buttons take two roles: the trigger rests as --status-error
    // letters and outline over its own tint (8% at rest, 18% hovered), and the
    // confirming button is filled with --danger under white letters. Both are
    // checked where they are actually drawn.
    it("keeps both destructive roles legible: the outlined trigger and the filled confirm", () => {
      const ink = hexOf(block, "--status-error");
      for (const surface of SURFACES) {
        for (const amount of [0.08, 0.18]) {
          check(ink, mix(ink, hexOf(block, surface), amount), 4.5, `--status-error on its ${amount * 100}% tint over ${surface}`);
        }
        check(ink, hexOf(block, surface), 3, `--status-error outline on ${surface}`);
      }
      for (const fill of ["--danger", "--danger-hover"]) {
        check([255, 255, 255], hexOf(block, fill), 4.5, `white on the ${fill} confirm fill`);
      }
    });

    it("keeps field outlines, the accent ring, and the scroll-bar thumb at 3:1 or more", () => {
      for (const mark of ["--field-border", "--accent-strong", "--scrollbar-thumb"]) {
        for (const surface of SURFACES) check(hexOf(block, mark), hexOf(block, surface), 3, `${mark} on ${surface}`);
      }
    });
  });

  it("defines every light color token again in the dark block", () => {
    const tokens = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(?:#|\d+ \d)/g)].map((match) => match[1]));
    const dark = tokens(themeBlock("dark"));
    for (const token of tokens(themeBlock("light"))) expect(dark.has(token), `${token} in the dark theme`).toBe(true);
    for (const token of ["--menu-shadow", "--modal-shadow"]) expect(themeBlock("dark")).toContain(`${token}:`);
  });

  it("references only defined tokens", () => {
    const root = resolve("src/gui/renderer/src");
    const sources = [css, ...[root, join(root, "components")].flatMap((dir) =>
      readdirSync(dir).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => readFileSync(join(dir, file), "utf8")))];
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    for (const source of sources) {
      for (const [, token] of source.matchAll(/var\((--[a-z0-9-]+)/g)) expect(defined.has(token), `${token} is defined`).toBe(true);
    }
  });
});
