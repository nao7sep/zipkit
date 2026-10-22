/**
 * Small, pure path-string helpers shared across passes. None touch the
 * filesystem; archive paths are always forward-slash, relative strings.
 */

import path from "node:path";

/** A relative disk path with the platform's separator turned into the
 *  archive's `/`. Only Windows separates with a backslash; elsewhere it is part
 *  of a name, which the name rules replace, never a folder boundary. */
export function toArchiveSeparators(relative: string, separator: string = path.sep): string {
  return separator === "\\" ? relative.replaceAll("\\", "/") : relative;
}

/** Whether the disk path `target` is `root` or inside it, by spelling alone.
 *  Only a `..` segment leads out, so a folder named `..notes` is inside. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function trimSlashes(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Lowercase extension including the leading dot, or "" when there is none. */
export function extnameLower(archivePath: string): string {
  const base = archivePath.slice(archivePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * Normalize a user-supplied extension to the form {@link extnameLower}
 * produces: lowercase with a single leading dot. Accepts `.txt`, `txt`, and
 * `.TXT` alike, so a store extension specified either way matches an entry. The
 * one place the SDK (`resolvePolicy`) fixes the extension dialect.
 */
export function normalizeExtension(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e.startsWith(".") ? e : `.${e}`;
}

/**
 * Resolve `.` and `..` against the path root, dropping empty segments. Returns
 * the surviving segments and whether a `..` escaped above the root. Shared by
 * path fixing and `as`-value validation so both agree on what a path means.
 */
export function resolveSegments(p: string): { segments: string[]; escaped: boolean } {
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { segments: [], escaped: true };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { segments, escaped: false };
}

/** Ancestor directory paths of an entry, from shallowest to deepest. */
export function ancestorDirs(archivePath: string): string[] {
  const segments = archivePath.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}
