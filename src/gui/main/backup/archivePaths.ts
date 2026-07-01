/**
 * Pure mapping from a home-root file's role to its entry path within the archive. zipkit keeps all its
 * durable data under `~/.zipkit/` (no externally-linked roots), so the archive is a faithful image of
 * that tree: every file maps straight, its path relative to the home root becomes its archive path. All
 * entry paths use forward slashes (see the data-backup conventions).
 */

/** Normalizes a filesystem-relative path to a forward-slash archive path. */
export function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** A file directly under `~/.zipkit/`: its relative path is the archive path (`config.json`). */
export function forHomeFile(relativePath: string): string {
  return normalize(relativePath);
}
