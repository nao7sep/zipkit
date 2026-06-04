/**
 * Path-level rooting (§10.2), the part of name fixing that operates on the
 * whole path rather than a single segment: strip absolute and drive-letter
 * prefixes (`path.absolute`), resolve `.`/`..` and reject paths that escape the
 * archive root (`path.traversal`), and flag over-length paths and components
 * (`path.too-long`). Runs before selection so the matcher sees a rooted path.
 *
 * `fixPath` is pure and exported for direct testing; filesystem-scanned entries
 * are already clean relatives, so these rules fire mainly on synthetic or
 * `as`-mapped inputs — exactly the paths that must be tested deliberately.
 */

import { finding } from "../registry.js";
import { resolveSegments, toForwardSlash } from "../internal/path.js";
import type { WorkItem } from "./workItem.js";

const MAX_COMPONENT = 255;
const MAX_PATH = 260;

export interface PathFixResult {
  path: string;
  strippedAbsolute: boolean;
  escaped: boolean;
  tooLongComponent: boolean;
  tooLongPath: boolean;
}

export function fixPath(input: string): PathFixResult {
  let p = toForwardSlash(input);

  let strippedAbsolute = false;
  // A drive prefix is a letter and colon followed by a separator (`C:/`,
  // originally `C:\`). A bare `a:b` is a filename whose colon is invalid on
  // Windows and is left for `name.invalid-char` to substitute, not stripped.
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
    tooLongComponent: segments.some((s) => s.length > MAX_COMPONENT),
    tooLongPath: finalPath.length > MAX_PATH,
  };
}

export function applyPathFix(items: WorkItem[]): void {
  for (const item of items) {
    if (item.excluded) continue;
    const before = item.archivePath;
    const result = fixPath(before);

    if (result.strippedAbsolute) {
      item.findings.push(
        finding("path.absolute", before, "absolute path prefix stripped", {
          kind: "rename",
          to: result.path,
        }),
      );
    }

    if (result.escaped) {
      item.findings.push(
        finding("path.traversal", before, "path escapes the archive root", { kind: "exclude" }),
      );
      item.excluded = true;
      item.excludeReason = "path traversal";
      continue;
    }

    item.archivePath = result.path;

    if (result.tooLongComponent || result.tooLongPath) {
      item.findings.push(
        finding(
          "path.too-long",
          result.path,
          result.tooLongComponent
            ? "a path component exceeds 255 characters"
            : "the full path exceeds 260 characters",
        ),
      );
    }
  }
}
