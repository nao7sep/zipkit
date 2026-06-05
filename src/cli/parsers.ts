/**
 * Commander argument parsers — the format-coercion edge. Each turns a
 * command-line string into a typed value and rejects only what is *not
 * coercible* (a non-number, a malformed size), throwing `InvalidArgumentError`
 * so Commander reports a usage error and the process exits 2. Semantic bounds —
 * "is this number in range?" — are deliberately *not* here: they belong to the
 * SDK, the single authority that a library caller hits too. So `0` and `64k`
 * both parse (coercible); whether `0` is an allowed chunk size is the SDK's call.
 */

import { InvalidArgumentError } from "commander";

/**
 * Parse a byte size with an optional `k`/`m` suffix (`64k`, `1m`, `65536`) into
 * an integer byte count. Rejects only non-coercible input; positivity is the
 * SDK's bound (`validateChunkSize`).
 */
export function parseByteSize(value: string): number {
  const m = /^(\d+)([km]?)$/i.exec(value.trim());
  if (!m) {
    throw new InvalidArgumentError("expected a byte count, optionally suffixed k or m (e.g. 64k, 1m)");
  }
  const n = Number.parseInt(m[1] as string, 10);
  const suffix = m[2]?.toLowerCase();
  const scale = suffix === "m" ? 1024 * 1024 : suffix === "k" ? 1024 : 1;
  return n * scale;
}

/**
 * Parse a base-10 integer. Rejects non-integers; range bounds (positive,
 * `1`–`9`, …) belong to the SDK that receives the value.
 */
export function parseInteger(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new InvalidArgumentError("expected an integer");
  }
  return Number.parseInt(trimmed, 10);
}
