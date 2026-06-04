/**
 * The metadata file: the serialized plan plus the raw scan data,
 * which together form a lossless record. It never stores absolute source paths
 * — only the archive-relative final and original paths. CRC-32 (already
 * computed) detects corruption; the optional SHA-256 establishes content
 * identity. Under deterministic output the volatile fields — the creation time
 * and per-entry timestamps — are omitted so the record is reproducible.
 *
 * Keys follow the entity-record role order: the header leads with
 * identity and its own provenance time, then classification-like config and
 * quantities; each entry leads with identity, then classification, quantity,
 * subject attributes, and finally the nested transformation list.
 */

import type { WriteEntry } from "../internal/types.js";
import type { ArchivePolicy, Plan } from "../types.js";
import { VERSION } from "../version.js";

export interface MetadataEntryInput {
  writeEntry: WriteEntry;
  crc32: number;
  sha256?: string;
}

function metadataEntry(input: MetadataEntryInput, deterministic: boolean): Record<string, unknown> {
  const entry = input.writeEntry;
  const out: Record<string, unknown> = {
    archivePath: entry.archivePath,
    originalPath: entry.originalPath,
    // The writer's classification is recorded verbatim — including "symlink",
    // which the public PlannedEntry collapses to "file" — so the metadata is a
    // lossless record.
    type: entry.type,
    method: entry.method,
    size: entry.size,
  };
  if (!deterministic) {
    out.mtimeNs = entry.mtimeNs.toString();
    out.birthtimeNs = entry.birthtimeNs.toString();
  }
  out.crc32 = input.crc32;
  if (input.sha256 !== undefined) out.sha256 = input.sha256;
  out.mode = entry.mode;
  out.transformations = entry.transformations;
  return out;
}

export function buildMetadata(
  plan: Plan,
  policy: ArchivePolicy,
  entries: MetadataEntryInput[],
  createdNs: bigint,
): Record<string, unknown> {
  const deterministic = policy.deterministic;
  const document: Record<string, unknown> = {
    tool: "zipkit",
    version: VERSION,
  };
  if (!deterministic) {
    document.createdUtc = {
      ns: createdNs.toString(),
      iso: new Date(Number(createdNs / 1_000_000n)).toISOString(),
    };
  }
  document.policy = policy;
  document.summary = plan.summary;
  document.entries = entries.map((entry) => metadataEntry(entry, deterministic));
  document.findings = plan.findings;
  return document;
}
