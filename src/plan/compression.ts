/**
 * Compression method selection (pass 8). An entry whose extension is in the
 * store set is stored, otherwise deflated. The store set is the policy's
 * `store` additions, seeded with the built-in already-compressed list when
 * `stored` is `"builtin"` and empty when it is `"none"`. Directories and
 * preserved symlinks are always stored. The method decided here is final: the
 * writer streams the entry with it and never reconsiders, so a deflated entry
 * can rarely end up a few bytes larger than its stored form — an accepted trade
 * for streaming arbitrarily large files in bounded memory.
 */

import { extnameLower } from "../internal/path.js";
import { DEFAULT_STORE_EXTENSIONS } from "../policy.js";
import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function applyCompression(items: WorkItem[], policy: ArchivePolicy): void {
  // `store` is already canonical (lowercase, leading dot) — resolvePolicy
  // normalizes it — and the built-in set and `extnameLower` share that form.
  const storeExtensions = new Set<string>([
    ...(policy.compression.stored === "builtin" ? DEFAULT_STORE_EXTENSIONS : []),
    ...policy.compression.store,
  ]);

  for (const item of items) {
    if (item.excluded) continue;
    if (item.type !== "file") {
      item.method = "store";
      continue;
    }
    item.method = storeExtensions.has(extnameLower(item.archivePath)) ? "store" : "deflate";
  }
}
