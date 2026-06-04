/**
 * Compression method selection (§4 pass 8, §10.8). Under `auto`, an entry whose
 * extension is in the store list is stored, otherwise deflated. `store-all` and
 * `compress-all` override per-extension behaviour. Directories and preserved
 * symlinks are always stored. The writer applies a further store fallback at
 * write time when deflate fails to shrink the data.
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
