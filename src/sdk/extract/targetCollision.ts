/**
 * Preflight extraction-target identity without pairwise scans. Normalized path
 * segments are sorted segment-by-segment, which keeps every descendant directly
 * inside its ancestor's contiguous range. A stack then detects exact duplicates
 * and non-directory ancestors in one pass after the O(n log n) sort.
 */

import { resolveSegments, toForwardSlash } from "../internal/path.js";
import type { ReadEntry } from "./zipReader.js";

interface TargetRecord {
  entry: ReadEntry;
  segments: string[];
}

function compareSegments(left: TargetRecord, right: TargetRecord): number {
  const length = Math.min(left.segments.length, right.segments.length);
  for (let i = 0; i < length; i++) {
    const a = left.segments[i]!;
    const b = right.segments[i]!;
    const order = a < b ? -1 : a > b ? 1 : 0;
    if (order !== 0) return order;
  }
  return left.segments.length - right.segments.length;
}

function isPrefix(ancestor: readonly string[], candidate: readonly string[]): boolean {
  if (ancestor.length > candidate.length) return false;
  return ancestor.every((segment, index) => segment === candidate[index]);
}

/** The first colliding pair after deterministic normalized target ordering. */
export function findTargetCollision(entries: readonly ReadEntry[]): [string, string] | null {
  const records: TargetRecord[] = [];
  for (const entry of entries) {
    const resolved = resolveSegments(toForwardSlash(entry.archivePath));
    if (resolved.escaped || resolved.segments.length === 0) continue;
    records.push({
      entry,
      segments: resolved.segments.map((segment) => segment.normalize("NFC").toLowerCase()),
    });
  }
  records.sort(compareSegments);

  const ancestors: TargetRecord[] = [];
  for (const record of records) {
    while (ancestors.length > 0 && !isPrefix(ancestors.at(-1)!.segments, record.segments)) {
      ancestors.pop();
    }
    const ancestor = ancestors.at(-1);
    if (ancestor) {
      if (ancestor.segments.length === record.segments.length || ancestor.entry.type !== "dir") {
        return [ancestor.entry.archivePath, record.entry.archivePath];
      }
    }
    ancestors.push(record);
  }
  return null;
}
