/**
 * Where the app's builds and tests find the SDK: its workspace package's
 * TypeScript source, entry by entry, as the package exports them under the
 * `zipkit-source` condition (the type checks resolve the same way through
 * `customConditions`). The app bundles the SDK from source, so a change to it
 * needs no package build first; any other path into the package resolves
 * through its exports map, which refuses it.
 */

import { fileURLToPath } from "node:url";

const entry = (file: string): string => fileURLToPath(new URL(`./packages/sdk/src/${file}`, import.meta.url));

export const sdkSource = [
  { find: /^zipkit$/, replacement: entry("index.ts") },
  { find: /^zipkit\/types$/, replacement: entry("types.ts") },
  { find: /^zipkit\/testing$/, replacement: entry("testing.ts") },
];
