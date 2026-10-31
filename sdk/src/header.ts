/**
 * The file identity header (file-identity conventions) on the one file the SDK
 * writes in a format of its own: the manifest embedded in each archive. The
 * format is ZipKit's, so its owner is `zipkit`; the writer is this package,
 * with the calling app as `caller` only when the app named itself. A reader
 * checks `format` alone and never reads `writer`.
 */

import type { Program } from "./types.ts";
import { VERSION } from "./version.ts";

export const FORMAT_OWNER = "zipkit";
export const MANIFEST_KIND = "manifest";
/** The manifest's format version (store-recovery conventions); a reader refuses a newer one. */
export const MANIFEST_FORMAT_VERSION = 1;

/** The `format` object every manifest this build writes carries. */
export function manifestFormat(): { owner: typeof FORMAT_OWNER; kind: typeof MANIFEST_KIND; version: number } {
  return { owner: FORMAT_OWNER, kind: MANIFEST_KIND, version: MANIFEST_FORMAT_VERSION };
}

/** The `writer` object: this package, and the caller when it named itself. */
export function manifestWriter(caller: Program | undefined): { name: string; version: string; caller?: Program } {
  return { name: "zipkitsdk", version: VERSION, ...(caller !== undefined ? { caller } : {}) };
}

/** What a document's `format` value says: this build's format, a newer version of it, or
 *  nothing this build reads, with why. */
export type FormatVerdict = { current: true } | { newer: number } | { invalid: string };

export function checkManifestFormat(format: unknown): FormatVerdict {
  if (format === null || typeof format !== "object" || Array.isArray(format)) return { invalid: "has no format header" };
  const { owner, kind, version } = format as Record<string, unknown>;
  if (typeof owner !== "string" || typeof kind !== "string") return { invalid: "has no valid format header" };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { invalid: "has no valid format version" };
  if (owner !== FORMAT_OWNER || kind !== MANIFEST_KIND) return { invalid: `holds ${owner} ${kind}, not a ZipKit manifest` };
  if (version > MANIFEST_FORMAT_VERSION) return { newer: version };
  return { current: true };
}
