/**
 * Looking into an archive without verifying it: its entries as the central
 * directory records them, and the manifest ZipKit embedded, read whole. Works
 * on any ZIP; only the manifest needs one ZipKit made.
 */

import { ZipKitError } from "../errors.ts";
import { machineTimeZone } from "../internal/timeZone.ts";
import type { Volume } from "../internal/volume.ts";
import { MANIFEST_DEFAULTS } from "../policy.ts";
import type { ArchiveListing, ListedEntry, Manifest } from "../types.ts";
import { MANIFEST_FORMAT_VERSION } from "../write/manifest.ts";
import { restoreTimes } from "./times.ts";
import { isManifestRecord, withArchive } from "./verify.ts";
import { readEntryData } from "./zipReader.ts";

function utcTime(ns: bigint): ListedEntry["modified"] {
  return { ns: ns.toString(), iso: new Date(Number(ns / 1_000_000n)).toISOString() };
}

/** The archive's entries in central-directory order. A time stored only in
 *  the DOS field is read in `timeZone`. */
export async function listArchive(volume: Volume, archivePath: string, timeZone = machineTimeZone()): Promise<ArchiveListing> {
  return withArchive(volume, archivePath, async (_archive, parsed) => ({
    archive: archivePath,
    zip64: parsed.zip64,
    entries: parsed.entries.map((entry): ListedEntry => ({
      archivePath: entry.archivePath,
      type: entry.type,
      method: entry.method === 0 ? "store" : entry.method === 8 ? "deflate" : "other",
      size: entry.uncompSize,
      compressedSize: entry.compSize,
      crc32: entry.crc32 >>> 0,
      modified: utcTime(restoreTimes(entry, timeZone).mtimeNs),
    })),
  }));
}

/** The manifest embedded as `name`, whole. Absent is `read.manifest-missing`,
 *  not JSON, without a valid `formatVersion` or `entries` list, or holding a
 *  malformed or repeated entry record is
 *  `read.manifest-invalid`, and one a newer ZipKit wrote is
 *  `read.manifest-newer`. */
export async function readArchiveManifest(volume: Volume, archivePath: string, name = MANIFEST_DEFAULTS.name): Promise<Manifest> {
  return withArchive(volume, archivePath, async (archive, parsed) => {
    const inside = parsed.entries.find((entry) => entry.archivePath === name);
    if (!inside) throw new ZipKitError("manifest.missing", `no manifest '${name}' is embedded in the archive`, { subject: name });
    const chunks: Buffer[] = [];
    await readEntryData(archive, inside, async (chunk) => { chunks.push(chunk); }, 65536);
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (err) {
      throw new ZipKitError("manifest.invalid", `manifest ${name} is not valid JSON`, { cause: err, subject: name });
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new ZipKitError("manifest.invalid", `manifest ${name} is not a JSON object`, { subject: name });
    }
    const { formatVersion, entries } = document as Record<string, unknown>;
    if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
      throw new ZipKitError("manifest.invalid", `manifest ${name} has no valid formatVersion`, { subject: name });
    }
    if (formatVersion > MANIFEST_FORMAT_VERSION) {
      throw new ZipKitError(
        "manifest.newer",
        `manifest ${name} has format version ${formatVersion}, newer than this build's ${MANIFEST_FORMAT_VERSION}`,
        { subject: name },
      );
    }
    if (!Array.isArray(entries)) throw new ZipKitError("manifest.invalid", `manifest ${name} has no entries list`, { subject: name });
    // The same records verification accepts, so a manifest that reads here
    // also verifies there.
    const paths = new Set<string>();
    for (const record of entries) {
      if (!isManifestRecord(record)) throw new ZipKitError("manifest.invalid", `manifest ${name} holds a malformed entry record`, { subject: name });
      if (paths.has(record.archivePath)) throw new ZipKitError("manifest.invalid", `manifest ${name} records '${record.archivePath}' twice`, { subject: name });
      paths.add(record.archivePath);
    }
    return document as Manifest;
  });
}
