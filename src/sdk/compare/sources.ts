/**
 * Compare a fresh plan of an archive's inputs with the archive's own manifest:
 * the check a caller makes before it deletes the originals. Only included
 * files and symlinks count, each by its input-relative source path, type, size
 * and modification time. Excluded entries (OS junk a file manager writes into
 * an open folder) and folders, whose times move whenever their contents do,
 * are left out, so an untouched tree always matches.
 *
 * Pure: the caller gathers the fresh plan's write entries and the manifest
 * records, which the manifest load has already checked.
 */

import type { WriteEntry } from "../internal/types.js";
import type { SourceComparison } from "../types.js";
import type { ManifestRecord } from "../extract/extract.js";

/** One compared object: its type, size and modification time. */
function signature(type: string, size: number, mtimeNs: string): string {
  return `${type}\0${size}\0${mtimeNs}`;
}

function add(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function recordSignature(record: ManifestRecord): { sourcePath: string; signature: string } | null {
  if (record.type === "dir") return null;
  return { sourcePath: record.sourcePath, signature: signature(record.type, record.size, record.mtime.ns) };
}

export function compareWithManifest(
  fresh: readonly WriteEntry[],
  unlisted: readonly string[],
  records: readonly ManifestRecord[],
): SourceComparison {
  const now = new Map<string, string[]>();
  for (const entry of fresh) {
    if (entry.type === "dir") continue;
    add(now, entry.sourcePath, signature(entry.type, entry.size, entry.mtimeNs.toString()));
  }
  const then = new Map<string, string[]>();
  for (const record of records) {
    const sig = recordSignature(record);
    if (sig) add(then, sig.sourcePath, sig.signature);
  }

  const added: string[] = [];
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [sourcePath, list] of now) {
    const before = then.get(sourcePath);
    if (!before) added.push(sourcePath);
    else if ([...list].sort().join("\n") !== [...before].sort().join("\n")) changed.push(sourcePath);
  }
  for (const sourcePath of then.keys()) if (!now.has(sourcePath)) missing.push(sourcePath);

  const sort = (list: string[]): string[] => list.sort();
  return {
    matches: added.length === 0 && missing.length === 0 && changed.length === 0 && unlisted.length === 0,
    added: sort(added),
    missing: sort(missing),
    changed: sort(changed),
    unlisted: sort([...unlisted]),
  };
}
