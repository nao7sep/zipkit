/**
 * Tests for the openExternal URL guard — the security boundary that keeps the
 * renderer from asking the OS to open a non-web scheme.
 */

import { describe, expect, it } from "vitest";
import { isHttpUrl } from "../../../src/gui/main/url.js";

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://github.com/nao7sep/zipkit")).toBe(true);
    expect(isHttpUrl("https://github.com/nao7sep/zipkit/issues")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects other schemes and malformed input", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("mailto:a@b.com")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
