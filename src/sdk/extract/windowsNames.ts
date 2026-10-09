/**
 * Extraction names on Windows. Windows cannot hold some names an archive may
 * carry: reserved device names (`CON`, `aux.txt`), the characters `< > : " | ? *`
 * (a `:` would write an NTFS alternate data stream), control characters, and
 * trailing dots or spaces, which it strips silently. On Windows each such path
 * segment is renamed with the same fixes ZipKit applies when it creates an
 * archive, so the entry is extracted under a name Windows keeps rather than lost
 * or written somewhere else. Normalization to NFC is left out: Windows holds
 * either form. The result is reported as the entry's `outputPath`.
 */

import { processSegment } from "../plan/nameFix.js";

/** One path segment as Windows can hold it; unchanged when it already can. */
export function windowsSafeSegment(segment: string): string {
  return processSegment(segment, {
    nfc: "none",
    invalidChars: "fix",
    invalidCharReplacement: "_",
    controlChars: "fix",
    trailingDotSpace: "fix",
    reserved: "fix",
    suspicious: "none",
  }).segment;
}

/** An entry's resolved segments as they are written on `platform`. */
export function extractionSegments(segments: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? segments.map(windowsSafeSegment) : segments;
}
