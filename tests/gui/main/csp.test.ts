/**
 * Tests for the production Content-Security-Policy — the defense-in-depth header
 * stamped on the renderer's responses. The runtime `onHeadersReceived` path can't
 * be exercised headlessly, so the policy is read through the pure
 * `withContentSecurityPolicy` seam (the one place the exact string is observable).
 *
 * Two jobs: (1) hold the line on the strict directives a future edit might quietly
 * weaken — `script-src` must stay `'self'` with no `'unsafe-inline'`/`'unsafe-eval'`,
 * and `'unsafe-eval'` must appear nowhere; (2) snapshot the CURRENT exact policy so
 * any drop, reorder, or loosening of a directive trips this test on purpose. The
 * one allowed inline relaxation — `style-src 'unsafe-inline'`, required for React
 * inline `style` props and Radix's scroll-lock <style> — is pinned by the snapshot,
 * not waved through by a blanket "no unsafe-inline" assertion.
 */

import { describe, expect, it } from "vitest";
import { withContentSecurityPolicy } from "../../../src/gui/main/csp.js";

/** Read the exact policy string the way the runtime header path would emit it. */
function productionCsp(): string {
  const header = withContentSecurityPolicy(undefined)["Content-Security-Policy"];
  expect(header).toHaveLength(1);
  const policy = header?.[0];
  if (policy === undefined) throw new Error("Content-Security-Policy header is missing");
  return policy;
}

/** Pull a single directive's value (everything after the name) from the policy. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();
}

describe("production CSP", () => {
  it("is present and non-empty", () => {
    expect(productionCsp().length).toBeGreaterThan(0);
  });

  it("keeps script-src strict — 'self' only, no 'unsafe-inline'/'unsafe-eval'", () => {
    const csp = productionCsp();
    expect(directive(csp, "script-src")).toBe("'self'");
    // Belt-and-braces beyond the exact match above: never let either token in.
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("uses 'unsafe-eval' nowhere in the policy", () => {
    expect(productionCsp()).not.toContain("'unsafe-eval'");
  });

  it("matches the current exact policy (snapshot — any weakening fails)", () => {
    // The literal expected string, pinned so a future drop/reorder/loosening of any
    // directive is a deliberate, visible change to this line rather than a silent
    // regression. Update only alongside a reviewed change to src/gui/main/csp.ts.
    expect(productionCsp()).toBe(
      "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self'; " +
        "font-src 'self'; " +
        "connect-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "frame-ancestors 'none'; " +
        "frame-src 'none'",
    );
  });
});
