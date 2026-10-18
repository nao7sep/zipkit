/**
 * Looking into an archive without verifying it: its entries as the central
 * directory records them, and the manifest ZipKit embedded, read whole. Works
 * on any ZIP; only the manifest needs one ZipKit made.
 */

import { ZipKitError } from "../errors.js";
import { machineTimeZone } from "../internal/timeZone.js";
import type { Volume, VolumeFile } from "../internal/volume.js";
import { METADATA_DEFAULTS } from "../policy.js";
import type { ArchiveListing, ListedEntry, Metadata } from "../types.js";
import { MANIFEST_FORMAT_VERSION } from "../write/metadata.js";
import { restoreTimes } from "./restore.js";
import { parseZip, readEntryData, type ParsedZip } from "./zipReader.js";

async function withArchive<T>(volume: Volume, archivePath: string, use: (archive: VolumeFile, parsed: ParsedZip) => Promise<T>): Promise<T> {
  let archive: VolumeFile;
  try {
    archive = await volume.open(archivePath, "r");
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    throw new ZipKitError("read.open-failed", `cannot read archive ${archivePath}`, { cause: err });
  }
  try {
    let fileSize: number;
    try {
      fileSize = Number((await archive.stat()).size);
    } catch (err) {
      if (err instanceof ZipKitError) throw err;
      throw new ZipKitError("read.open-failed", `cannot read archive ${archivePath}`, { cause: err });
    }
    return await use(archive, await parseZip(archive, fileSize));
  } finally {
    await archive.release();
  }
}

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
 *  not JSON or without a valid `formatVersion` or `entries` list is
 *  `read.manifest-invalid`, and one a newer ZipKit wrote is
 *  `read.manifest-newer`. */
export async function readArchiveManifest(volume: Volume, archivePath: string, name = METADATA_DEFAULTS.name): Promise<Metadata> {
  return withArchive(volume, archivePath, async (archive, parsed) => {
    const inside = parsed.entries.find((entry) => entry.archivePath === name);
    if (!inside) throw new ZipKitError("read.manifest-missing", `no manifest '${name}' is embedded in the archive`);
    const chunks: Buffer[] = [];
    await readEntryData(archive, inside, async (chunk) => { chunks.push(chunk); }, 65536);
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (err) {
      throw new ZipKitError("read.manifest-invalid", `manifest ${name} is not valid JSON`, { cause: err });
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new ZipKitError("read.manifest-invalid", `manifest ${name} is not a JSON object`);
    }
    const { formatVersion, entries } = document as Record<string, unknown>;
    if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
      throw new ZipKitError("read.manifest-invalid", `manifest ${name} has no valid formatVersion`);
    }
    if (formatVersion > MANIFEST_FORMAT_VERSION) {
      throw new ZipKitError(
        "read.manifest-newer",
        `manifest ${name} has format version ${formatVersion}, newer than this build's ${MANIFEST_FORMAT_VERSION}`,
      );
    }
    if (!Array.isArray(entries)) throw new ZipKitError("read.manifest-invalid", `manifest ${name} has no entries list`);
    return document as Metadata;
  });
}
