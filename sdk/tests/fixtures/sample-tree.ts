/**
 * The source tree behind the saved sample archives: names that exercise the
 * fixes (a decomposed name, a character Windows forbids), OS junk, an empty
 * file, a file stored uncompressed and nested folders, all with one fixed
 * modification time so what is written depends on the tree alone.
 */

import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArchivePolicy, DeepPartial } from "../../src/index.ts";

export const SAMPLE_TIME = new Date("2026-01-02T03:04:05Z");

/** Written with UTC as the DOS-time zone, so the archive is the same on every machine. */
export const SAMPLE_POLICY: DeepPartial<ArchivePolicy> = { timezone: "UTC" };

export const SAMPLE_FILES: ReadonlyArray<{ name: string; content: string | Buffer }> = [
  { name: "README.md", content: "# Sample\n" },
  { name: "docs/notes:v1.txt", content: "a name Windows cannot hold\n" },
  { name: "café.txt", content: "a decomposed name\n" },
  { name: "photos/photo.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]) },
  { name: "empty.txt", content: "" },
  { name: "sub/deep/data.bin", content: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
  { name: ".DS_Store", content: "junk" },
];

/** Write the tree under `root` (its folder named `sample`), every item with the fixed time. */
export async function makeSampleTree(root: string): Promise<string> {
  const top = path.join(root, "sample");
  for (const { name, content } of SAMPLE_FILES) {
    const file = path.join(top, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  // Files first, then folders deepest first, so writing a file never moves a folder's time again.
  for (const { name } of SAMPLE_FILES) await utimes(path.join(top, ...name.split("/")), SAMPLE_TIME, SAMPLE_TIME);
  for (const dir of ["sub/deep", "sub", "photos", "docs", ""]) await utimes(path.join(top, ...dir.split("/").filter(Boolean)), SAMPLE_TIME, SAMPLE_TIME);
  return top;
}

const byPath = (a: { archivePath: unknown }, b: { archivePath: unknown }): number =>
  String(a.archivePath) < String(b.archivePath) ? -1 : String(a.archivePath) > String(b.archivePath) ? 1 : 0;

/** What a manifest says that does not depend on when or where it was written:
 *  its entries' identities, sizes and content checks, what was left out and
 *  why, the findings and the summary. */
export function manifestEssentials(manifest: Record<string, unknown>): unknown {
  const m = manifest as {
    formatVersion: number; policy: unknown; summary: unknown;
    entries: Array<Record<string, unknown>>; excluded: unknown; findings: Array<Record<string, unknown>>;
  };
  return {
    formatVersion: m.formatVersion,
    policy: m.policy,
    summary: m.summary,
    // In archive-path order, since the scan finds them concurrently; a
    // folder's recorded size is its file system's, so it is left out.
    entries: m.entries.map((e) => ({
      archivePath: e.archivePath, originalPath: e.originalPath, sourcePath: e.sourcePath, type: e.type,
      method: e.method, size: e.type === "dir" ? undefined : e.size, compressedSize: e.compressedSize,
      crc32: e.crc32, sha256: e.sha256, mtime: e.mtime, transformations: e.transformations,
    })).sort(byPath),
    excluded: [...(m.excluded as Array<{ archivePath: string }>)].sort(byPath),
    findings: m.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path }))
      .sort((a, b) => `${a.path}\0${a.rule}`.localeCompare(`${b.path}\0${b.rule}`)),
  };
}
