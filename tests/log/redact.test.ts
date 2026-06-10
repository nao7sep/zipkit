/**
 * The mandatory redactor: case-insensitive exact key-name matching (never
 * substring), wholesale value replacement, recursion through objects and arrays,
 * the envelope `message` left untouched, and purity (no input mutation, total on
 * any value).
 */

import { describe, expect, it } from "vitest";
import { redact } from "../../src/log/redact.js";

describe("redact", () => {
  it("redacts every seeded denied key, case-insensitively", () => {
    const out = redact({
      apiKey: "sk-1",
      APIKEY: "x",
      Authorization: "Bearer z",
      token: "t",
      password: "p",
      secret: "s",
    });
    expect(out).toEqual({
      apiKey: "[redacted]",
      APIKEY: "[redacted]",
      Authorization: "[redacted]",
      token: "[redacted]",
      password: "[redacted]",
      secret: "[redacted]",
    });
  });

  it("matches the whole name only, never a substring", () => {
    const input = { tokenCount: 7, broken: true, myToken: "keep", access_token: "keep" };
    expect(redact(input)).toEqual(input);
  });

  it("never edits the envelope message, even when it names a secret", () => {
    const out = redact({ message: "apiKey=sk-secret appears in this text", level: "info" });
    expect(out.message).toBe("apiKey=sk-secret appears in this text");
  });

  it("recurses objects and arrays, replacing a matched object value wholesale", () => {
    const out = redact({
      a: { token: { nested: 1 } },
      list: [{ password: "p" }, { keep: "v" }],
    });
    expect(out).toEqual({
      a: { token: "[redacted]" },
      list: [{ password: "[redacted]" }, { keep: "v" }],
    });
  });

  it("does not mutate its input", () => {
    const input = { token: "t", nested: { secret: "s" }, list: [{ password: "p" }] };
    const before = structuredClone(input);
    redact(input);
    expect(input).toEqual(before);
  });

  it("is total on null, undefined, primitives, and arrays", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact("token")).toBe("token"); // a bare string is never scanned
    expect(redact([1, "two", null])).toEqual([1, "two", null]);
  });

  it("passes non-record objects through unchanged (never rebuilt into a bare {})", () => {
    class Box {
      token = "t";
    }
    const date = new Date("2026-06-10T00:00:00.000Z");
    const buf = Buffer.from("hi");
    const map = new Map([["password", "p"]]);
    const box = new Box();

    const out = redact({ date, buf, map, box, deep: [{ secret: "s" }] });

    // Non-records keep their identity and prototype — not corrupted, not redacted.
    expect(out.date).toBe(date);
    expect(out.buf).toBe(buf);
    expect(out.map).toBe(map);
    expect(out.box).toBe(box);
    expect(out.box).toBeInstanceOf(Box);
    // Plain records nested alongside them are still redacted.
    expect(out.deep).toEqual([{ secret: "[redacted]" }]);
  });

  it("does not throw on a self-referential structure and still redacts the rest", () => {
    const node: Record<string, unknown> = { token: "t", name: "a" };
    node.self = node; // cycle
    let out: Record<string, unknown> = {};
    expect(() => {
      out = redact(node);
    }).not.toThrow();
    expect(out.token).toBe("[redacted]");
    expect(out.name).toBe("a");
    expect(out.self).toBe(node); // the back-edge is left as-is
  });

  it("redacts a shared (acyclic) reference in every position it appears", () => {
    const shared = { password: "p", keep: "v" };
    const out = redact({ a: shared, b: shared });
    expect(out).toEqual({
      a: { password: "[redacted]", keep: "v" },
      b: { password: "[redacted]", keep: "v" },
    });
  });
});
