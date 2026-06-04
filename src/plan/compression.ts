/**
 * Compression method selection (pass 8). Under `auto`, an entry whose
 * extension is in the store list is stored, otherwise deflated. `store-all` and
 * `compress-all` override per-extension behaviour. Directories and preserved
 * symlinks are always stored. The method decided here is final: the writer
 * streams the entry with it and never reconsiders, so a deflated entry can
 * rarely end up a few bytes larger than its stored form — an accepted trade for
 * streaming arbitrarily large files in bounded memory.
 */

import { extnameLower } from "../internal/path.js";
import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function applyCompression(items: WorkItem[], policy: ArchivePolicy): void {
  const { mode } = policy.compression;
  const storeExtensions = new Set(policy.compression.storeExtensions.map((e) => e.toLowerCase()));

  for (const item of items) {
    if (item.excluded) continue;
    if (item.type !== "file") {
      item.method = "store";
      continue;
    }
    if (mode === "store-all") {
      item.method = "store";
    } else if (mode === "compress-all") {
      item.method = "deflate";
    } else {
      item.method = storeExtensions.has(extnameLower(item.archivePath)) ? "store" : "deflate";
    }
  }
}
