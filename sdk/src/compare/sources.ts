/**
 * Compare a fresh plan of an archive's inputs with the archive's own manifest:
 * the check a caller makes before it deletes the originals. Only included
 * files and symlinks count, each by its input-relative source path, type, size
 * and modification time. Excluded entries (such as the clutter a file manager
 * writes into an open folder) and folders, whose times move whenever their
 * contents do, are left out, so an untouched tree always matches. The comparison runs on
 * source paths, the manifest's key; {@link onDisk} turns its answer into the
 * places on disk a person would look.
 *
 * Pure: the caller gathers the fresh plan's write entries and the manifest
 * records, which the manifest load has already checked.
 */

import path from "node:path";
import type { WriteEntry } from "../internal/types.ts";
import type { SourceComparison } from "../types.ts";
import type { ManifestRecord } from "../read/verify.ts";

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

/** An input's own name: the first segment of every source path it contributed. */
function inputName(input: string): string {
  return path.basename(input);
}

/**
 * A comparison of only the inputs still present, after some were already
 * removed: the manifest entries the removed inputs contributed are missing by
 * design, so they are not a difference. A removed input that shares its name
 * with one still present explains nothing, since their entries cannot be told
 * apart.
 */
export function explainRemoved(comparison: SourceComparison, present: readonly string[], removed: readonly string[]): SourceComparison {
  if (removed.length === 0) return comparison;
  const presentNames = new Set(present.map(inputName));
  const removedNames = new Set(removed.map(inputName).filter((name) => !presentNames.has(name)));
  const missing = comparison.missing.filter((p) => !removedNames.has(p.split("/")[0] ?? ""));
  const matches =
    comparison.added.length === 0 &&
    missing.length === 0 &&
    comparison.changed.length === 0 &&
    comparison.unlisted.length === 0;
  return { ...comparison, missing, matches };
}

/**
 * A comparison keyed by source path, as the places on disk it names: an item
 * found now by where the fresh scan found it, and one only the manifest
 * records by the input its source path starts with. Inputs still present are
 * preferred to removed ones of the same name, and a filesystem-root input,
 * which contributes no name, takes a path no named input claims.
 */
export function onDisk(
  comparison: SourceComparison,
  found: ReadonlyMap<string, readonly string[]>,
  inputs: readonly string[],
  removed: readonly string[],
): SourceComparison {
  const byName = new Map<string, string>();
  for (const input of [...removed, ...inputs]) byName.set(inputName(input), input);
  const recorded = (sourcePath: string): string => {
    const [first = "", ...rest] = sourcePath.split("/");
    const input = byName.get(first);
    if (input !== undefined) return path.join(input, ...rest);
    const root = byName.get("");
    return root !== undefined ? path.join(root, sourcePath) : sourcePath;
  };
  const now = (list: readonly string[]): string[] => [...new Set(list.flatMap((p) => found.get(p) ?? [recorded(p)]))].sort();
  return {
    matches: comparison.matches,
    added: now(comparison.added),
    missing: comparison.missing.map(recorded).sort(),
    changed: now(comparison.changed),
    unlisted: now(comparison.unlisted),
  };
}
