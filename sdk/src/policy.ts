/**
 * Policy layering. The resolved policy is what every rule pass reads; it is
 * produced by merging the per-call policy over the instance policy over the
 * built-in defaults (`defaults.ts`). Validation lives in `validate.ts`; this
 * file only assembles a complete {@link ArchivePolicy} from partial layers.
 */

import { createDefu } from "defu";
import { DEFAULT_POLICY } from "./defaults.ts";
import { normalizeExtension } from "./internal/path.ts";
import type { ArchivePolicy, DeepPartial } from "./types.ts";

export { DEFAULT_DEFLATE_LEVEL, DEFAULT_POLICY, DEFAULT_STORE_EXTENSIONS, MANIFEST_DEFAULTS, NAME_DEFAULTS } from "./defaults.ts";

/**
 * The policy merger. It is `defu` with one rule changed: a list-valued field
 * *replaces* rather than concatenates, so a more specific layer's array wins
 * outright instead of being appended to the broader layer's. The rule is keyed
 * on the value being an array, not on a field name, so every list — `exclusions`,
 * `compression.store`, and any future one — obeys it with no per-field
 * bookkeeping. Scalars and nested objects keep `defu`'s deep-merge, which fills
 * a partial `names` or `manifest` object from the layer below and completes it
 * from the defaults. In `defu`'s merger the accumulator holds the lower-priority
 * value (`object[key]`) and `value` is the higher-priority one, so assigning
 * `value` is "the more specific array wins."
 */
const mergePolicy = createDefu((object, key, value) => {
  if (Array.isArray(value)) {
    object[key] = value;
    return true;
  }
  // defu's merger contract: true means "handled here", false means "fall through
  // to the default deep merge". Stated explicitly rather than left to an implicit
  // undefined, so the scalar/nested-object path reads as a decision.
  return false;
});

/**
 * Merge the per-call policy over the instance policy over the defaults into a
 * complete {@link ArchivePolicy}. Lists replace (see {@link mergePolicy}); the
 * resolved `compression.store` is then normalized to the canonical
 * lowercase-dotted extension form, so this is the single place the dialect is
 * fixed — a caller passing `txt`, `.txt`, or `.TXT` reaches `applyCompression`
 * identically.
 */
export function resolvePolicy(
  instance?: DeepPartial<ArchivePolicy>,
  call?: DeepPartial<ArchivePolicy>,
): ArchivePolicy {
  // Clone the defaults so a resolved policy never shares a nested object or
  // array with the module-global default; `defu` only shallow-copies its
  // last source.
  const merged = mergePolicy(
    call ?? {},
    instance ?? {},
    structuredClone(DEFAULT_POLICY),
  ) as ArchivePolicy;

  merged.compression.store = merged.compression.store.map(normalizeExtension);

  return merged;
}
