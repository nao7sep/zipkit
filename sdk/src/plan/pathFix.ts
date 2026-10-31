/**
 * Path-level rooting, the part of name fixing that operates on the
 * whole path rather than a single segment: strip absolute and drive-letter
 * prefixes (`path.absolute`), resolve `.`/`..` and reject paths that escape the
 * archive root (`path.traversal`). Rooting runs before selection so the matcher
 * sees a rooted path. Length diagnostics (`path.too-long`) run after the name
 * fixes, against the paths recipients will receive.
 *
 * Windows limits a full path to 260 characters, and an archive's entries land
 * below where the recipient extracts it: Windows' "Extract All" makes a folder
 * named after the archive, inside a folder such as `C:\Users\<name>\Downloads\`.
 * An entry path is therefore measured against what is left of the limit after
 * that folder's name and an allowance for where it is put
 * ({@link windowsPathBudget}). It is a warning, since the recipient may extract
 * somewhere shorter.
 *
 * `fixPath` is pure and exported for direct testing; filesystem-scanned entries
 * are already clean relatives, so these rules fire mainly on synthetic or
 * `as`-mapped inputs — exactly the paths that must be tested deliberately.
 */

import { finding } from "../registry.ts";
import { resolveSegments } from "../internal/path.ts";
import type { WorkItem } from "./workItem.ts";

const MAX_COMPONENT = 255;
const MAX_PATH = 260;
/** Room for the folder a recipient extracts into, `C:\Users\<name>\Downloads\`
 *  and its like, separator included. */
const EXTRACT_LOCATION_ALLOWANCE = 40;

/** How long an entry path may be once the archive `output` is extracted with
 *  Windows' "Extract All": the limit, less the folder it makes (the archive's
 *  name without `.zip`, and a separator) and the allowance for where it is. */
export function windowsPathBudget(output: string): number {
  const stem = (output.split(/[\\/]/).pop() ?? "").replace(/\.zip$/i, "");
  return MAX_PATH - EXTRACT_LOCATION_ALLOWANCE - (stem.length + 1);
}

export interface PathFixResult {
  path: string;
  strippedAbsolute: boolean;
  escaped: boolean;
  tooLongComponent: boolean;
  tooLongPath: boolean;
}

export function fixPath(input: string, maxPath = MAX_PATH): PathFixResult {
  // Archive paths separate with `/` only; a backslash is part of a name.
  let p = input;

  let strippedAbsolute = false;
  // A drive prefix is a letter and colon followed by a separator (`C:/`). A
  // bare `a:b` is a filename whose colon is invalid on Windows and is left for
  // `name.invalid-char` to substitute, not stripped.
  if (/^[A-Za-z]:\//.test(p)) {
    p = p.replace(/^[A-Za-z]:\/+/, "");
    strippedAbsolute = true;
  } else if (p.startsWith("/")) {
    p = p.replace(/^\/+/, "");
    strippedAbsolute = true;
  }

  const { segments, escaped } = resolveSegments(p);
  const finalPath = segments.join("/");
  return {
    path: finalPath,
    strippedAbsolute,
    escaped,
    // Linux file systems limit a name to 255 bytes of UTF-8, Windows and
    // macOS to 255 characters; a name must fit both.
    tooLongComponent: segments.some((s) => s.length > MAX_COMPONENT || Buffer.byteLength(s, "utf8") > MAX_COMPONENT),
    tooLongPath: finalPath.length > maxPath,
  };
}

export function applyPathFix(items: WorkItem[], maxPath = MAX_PATH): void {
  for (const item of items) {
    if (item.excluded) continue;
    const before = item.archivePath;
    const result = fixPath(before, maxPath);

    if (result.strippedAbsolute) {
      item.findings.push(
        finding("path.absolute", before, "absolute path prefix stripped", {
          fix: { kind: "rename", to: result.path },
        }),
      );
    }

    if (result.escaped) {
      item.findings.push(
        finding("path.traversal", before, "path escapes the archive root", {
          fix: { kind: "exclude" },
        }),
      );
      item.excluded = true;
      item.excludeCode = "path-traversal";
      item.excludeReason = "path traversal";
      continue;
    }

    item.archivePath = result.path;
  }
}

/** Portability depends on the final name, after substitutions and normalization. */
export function applyPathLength(items: WorkItem[], maxPath = MAX_PATH): void {
  for (const item of items) {
    if (item.excluded) continue;
    const result = fixPath(item.archivePath, maxPath);
    if (result.tooLongComponent || result.tooLongPath) {
      item.findings.push(
        finding(
          "path.too-long",
          result.path,
          result.tooLongComponent
            ? "a path component exceeds 255 characters or 255 bytes"
            : `the path exceeds the ${maxPath} characters left of Windows' 260 once extracted into a folder named after the archive`,
        ),
      );
    }
  }
}
