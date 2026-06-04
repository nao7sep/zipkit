/**
 * The extract/validate edge. One pass over the archive drives both: every entry
 * is decompressed and CRC-checked (so a dry run is a pure integrity test that
 * works on any ZIP); under `checkMetadata` each entry is also reconciled against
 * the manifest and its recorded SHA-256; and unless `dryRun` is set, verified
 * entries are written to disk with their times restored.
 *
 * CRC governs writing — a corrupt entry is never written. Path safety, exclusion,
 * and the overwrite gate decide the rest. Completeness (missing/extra) is
 * computed from the entry-name sets, independent of the decompression loop. The
 * report carries every per-entry outcome; the caller decides what is fatal.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { ReadError, throwIfAborted } from "../errors.js";
import { buildMatcher } from "../filter/match.js";
import { resolveSegments, toForwardSlash } from "../internal/path.js";
import { machineTimeZone } from "../internal/timeZone.js";
import type { Logger } from "../log/logger.js";
import type { ExtractEntryResult, ExtractReport, ExtractSpec, Finding } from "../types.js";
import { restoreTimes } from "./restore.js";
import { parseZip, readEntryData, type ReadEntry } from "./zipReader.js";

export interface ExtractDeps {
  logger: Logger;
  signal?: AbortSignal;
}

interface WriteOptions {
  overwrite: boolean;
  restore: boolean;
  timeZone: string;
  symlinks: "restore" | "skip";
}

/** Join an entry path under `dest`, or null when it would escape the directory. */
function safeJoin(dest: string, archivePath: string): string | null {
  const { segments, escaped } = resolveSegments(toForwardSlash(archivePath));
  if (escaped || segments.length === 0) return null;
  const target = path.join(dest, ...segments);
  const rel = path.relative(dest, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Write one verified entry; returns false when an existing file was preserved. */
async function writeEntry(
  entry: ReadEntry,
  data: Buffer,
  target: string,
  options: WriteOptions,
): Promise<boolean> {
  if (entry.type === "dir") {
    await mkdir(target, { recursive: true });
    return true;
  }
  await mkdir(path.dirname(target), { recursive: true });
  if (!options.overwrite && (await pathExists(target))) return false;

  if (entry.type === "symlink") {
    if (options.overwrite) await rm(target, { force: true });
    await symlink(data.toString("utf8"), target);
    return true; // link times are not restored: no portable lutimes guarantee
  }

  await writeFile(target, data);
  if (options.restore) {
    const t = restoreTimes(entry, options.timeZone);
    // Best-effort: a filesystem that rejects the times must not fail the write.
    try {
      await utimes(target, new Date(t.atimeMs), new Date(t.mtimeMs));
    } catch {
      /* times are advisory; the content is what matters */
    }
  }
  return true;
}

function finding(rule: string, severity: Finding["severity"], path: string, message: string): Finding {
  return { rule, severity, path, message };
}

interface ManifestRecord {
  archivePath?: unknown;
  sha256?: unknown;
}

export async function extractArchive(spec: ExtractSpec, deps: ExtractDeps): Promise<ExtractReport> {
  const signal = deps.signal;
  throwIfAborted(signal);

  const write = spec.dryRun !== true;
  if (write && (spec.dest === undefined || spec.dest === "")) {
    throw new ReadError(
      "read.no-dest",
      "extract requires a destination directory unless dryRun is set",
    );
  }
  const timeZone = spec.timezone ?? machineTimeZone();
  const writeOptions: WriteOptions = {
    overwrite: spec.overwrite === true,
    restore: (spec.timestamps ?? "restore") === "restore",
    timeZone,
    symlinks: spec.symlinks ?? "restore",
  };
  const onUnsafe = spec.onUnsafe ?? "skip";
  // The same exclusion engine the archive side uses; no junk preset on read.
  const matcher = buildMatcher(spec.exclude ?? [], false);
  const dest = spec.dest !== undefined ? path.resolve(spec.dest) : undefined;

  let buf: Buffer;
  try {
    buf = await readFile(spec.archive);
  } catch (err) {
    throw new ReadError("read.open-failed", `cannot read archive ${spec.archive}`, { cause: err });
  }
  const parsed = parseZip(buf);
  deps.logger.emit("extract", "info", "extract.start", {
    data: { entries: parsed.entries.length, write },
  });

  // Manifest resolution (heavy mode): prefer an entry inside the zip, else a
  // sidecar file alongside it. Requested-but-absent is a hard failure.
  let manifest: ExtractReport["manifest"] = null;
  let manifestEntryPath: string | undefined;
  const manifestMap = new Map<string, ManifestRecord>();
  if (spec.checkMetadata) {
    const name = spec.metadataName ?? "_metadata.json";
    const inside = parsed.entries.find((e) => e.archivePath === name);
    let doc: { entries?: unknown } | undefined;
    if (inside) {
      manifestEntryPath = inside.archivePath;
      try {
        doc = JSON.parse(readEntryData(buf, inside).toString("utf8"));
      } catch (err) {
        throw new ReadError("read.manifest-invalid", `manifest ${name} is not valid JSON`, {
          cause: err,
        });
      }
      manifest = { source: "inside", name };
    } else {
      try {
        doc = JSON.parse(await readFile(path.join(path.dirname(spec.archive), name), "utf8"));
        manifest = { source: "sidecar", name };
      } catch {
        /* falls through to the missing-manifest error below */
      }
    }
    if (!manifest) {
      throw new ReadError(
        "read.manifest-missing",
        `metadata validation requested but no manifest '${name}' was found inside the archive or alongside it`,
      );
    }
    const docEntries = Array.isArray(doc?.entries) ? (doc.entries as ManifestRecord[]) : [];
    for (const m of docEntries) {
      if (typeof m.archivePath === "string") manifestMap.set(m.archivePath, m);
    }
  }

  const entries: ExtractEntryResult[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let crcFailed = 0;
  let shaMismatched = 0;
  let unsafe = 0;
  let written = 0;
  let skipped = 0;

  for (const entry of parsed.entries) {
    throwIfAborted(signal);
    const isManifestEntry = entry.archivePath === manifestEntryPath;
    if (!isManifestEntry) seen.add(entry.archivePath);

    const data = readEntryData(buf, entry);
    const crcOk = entry.type === "dir" || zlib.crc32(data) === (entry.crc32 >>> 0);
    if (!crcOk) {
      crcFailed++;
      findings.push(
        finding("extract.crc-fail", "error", entry.archivePath, "CRC-32 mismatch: entry is corrupt"),
      );
    }

    let sha: ExtractEntryResult["sha"];
    if (spec.checkMetadata && entry.type !== "dir" && !isManifestEntry) {
      const record = manifestMap.get(entry.archivePath);
      if (record && typeof record.sha256 === "string") {
        const actual = createHash("sha256").update(data).digest("hex");
        sha = actual === record.sha256 ? "ok" : "mismatch";
        if (sha === "mismatch") {
          shaMismatched++;
          findings.push(
            finding(
              "extract.sha-mismatch",
              "error",
              entry.archivePath,
              "content hash does not match the manifest",
            ),
          );
        }
      } else {
        sha = "absent";
      }
    }

    let didWrite = false;
    let skip: ExtractEntryResult["skipped"];
    let outputPath: string | undefined;
    if (!write) {
      skip = "dry-run";
    } else if (!crcOk) {
      skip = "crc-fail";
    } else if (matcher.match(entry.archivePath, entry.type === "dir")) {
      skip = "excluded";
    } else {
      const target = safeJoin(dest as string, entry.archivePath);
      if (target === null) {
        unsafe++;
        skip = "unsafe";
        findings.push(
          finding(
            "extract.unsafe-path",
            "error",
            entry.archivePath,
            "entry path escapes the destination directory",
          ),
        );
        if (onUnsafe === "abort") {
          throw new ReadError(
            "read.unsafe-path",
            `entry '${entry.archivePath}' escapes the destination directory`,
          );
        }
      } else if (entry.type === "symlink" && writeOptions.symlinks === "skip") {
        skip = "symlink-skip";
      } else {
        outputPath = target;
        try {
          didWrite = await writeEntry(entry, data, target, writeOptions);
        } catch (err) {
          throw new ReadError("read.write-failed", `cannot write ${entry.archivePath}`, {
            cause: err,
          });
        }
        if (!didWrite) skip = "exists";
      }
    }
    if (didWrite) written++;
    else skipped++;

    const result: ExtractEntryResult = {
      archivePath: entry.archivePath,
      type: entry.type,
      crc: crcOk ? "ok" : "fail",
      written: didWrite,
    };
    if (sha !== undefined) result.sha = sha;
    if (skip !== undefined) result.skipped = skip;
    if (outputPath !== undefined) result.outputPath = outputPath;
    entries.push(result);
  }

  const missing: string[] = [];
  const extra: string[] = [];
  if (spec.checkMetadata) {
    for (const key of manifestMap.keys()) if (!seen.has(key)) missing.push(key);
    for (const key of seen) if (!manifestMap.has(key)) extra.push(key);
    for (const m of missing) {
      findings.push(
        finding("extract.missing", "error", m, "entry is in the manifest but absent from the archive"),
      );
    }
    for (const e of extra) {
      findings.push(
        finding("extract.extra", "warning", e, "entry is in the archive but absent from the manifest"),
      );
    }
  }

  const ok =
    crcFailed === 0 &&
    unsafe === 0 &&
    (!spec.checkMetadata || (missing.length === 0 && extra.length === 0 && shaMismatched === 0));

  deps.logger.emit("extract", "info", "extract.done", {
    data: { total: entries.length, crcFailed, shaMismatched, written, skipped, ok },
  });

  const report: ExtractReport = {
    archive: spec.archive,
    wrote: written > 0,
    manifest,
    entries,
    missing,
    extra,
    findings,
    summary: { total: entries.length, crcFailed, shaMismatched, written, skipped },
    ok,
  };
  if (spec.dest !== undefined) report.dest = spec.dest;
  return report;
}
