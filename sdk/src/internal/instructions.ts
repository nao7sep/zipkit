/**
 * The plan → write handoff. `write(plan)` is self-contained: given only a plan,
 * it reads the right bytes from disk, because the plan carries the writer's
 * instructions as plain data in its `instructions` field. Times are decimal
 * nanosecond strings rather than bigints, so a plan survives a structured
 * clone or a JSON round trip unchanged and is still writable on the other side:
 * an app hands it to another process as it is.
 *
 * The SDK works on the bigint form ({@link PlanInternals}); this module turns
 * one into the other, and checks the shape of instructions that come back,
 * since a caller may hand `write` anything.
 */

import type { ArchivePolicy, InstructionEntry, PlanInstructions } from "../types.ts";
import type { WriteEntry } from "./types.ts";

export interface PlanInternals {
  /** Included entries, in plan order, ready for the writer. */
  writeEntries: WriteEntry[];
  /** The resolved policy governing selection, naming, compression, and manifest. */
  policy: ArchivePolicy;
  /** Whether replacing an output that exists at publication time was authorized. */
  overwrite: boolean;
  /** The resolved IANA zone the DOS local-time fields are rendered in. */
  timeZone: string;
  /** The archive comment from the spec, written to the EOCD and the manifest. */
  comment?: string | undefined;
}

export function toInstructions(internals: PlanInternals): PlanInstructions {
  const instructions: PlanInstructions = {
    policy: internals.policy,
    overwrite: internals.overwrite,
    timeZone: internals.timeZone,
    entries: internals.writeEntries.map((e): InstructionEntry => {
      const entry: InstructionEntry = {
        archivePath: e.archivePath,
        originalPath: e.originalPath,
        sourcePath: e.sourcePath,
        type: e.type,
        method: e.method,
        absolutePath: e.absolutePath,
        size: e.size,
        mtimeNs: e.mtimeNs.toString(),
        atimeNs: e.atimeNs.toString(),
        ctimeNs: e.ctimeNs.toString(),
        birthtimeNs: e.birthtimeNs.toString(),
        mode: e.mode,
        nameFixes: e.nameFixes,
      };
      if (e.linkTarget !== undefined) entry.linkTarget = e.linkTarget;
      return entry;
    }),
  };
  if (internals.comment !== undefined) instructions.comment = internals.comment;
  return instructions;
}

const NS = /^-?\d+$/;

function isEntry(value: unknown): value is InstructionEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.archivePath === "string" && typeof e.originalPath === "string" &&
    typeof e.sourcePath === "string" && typeof e.absolutePath === "string" &&
    (e.type === "file" || e.type === "dir" || e.type === "symlink") &&
    (e.method === "store" || e.method === "deflate") &&
    Number.isSafeInteger(e.size) && (e.size as number) >= 0 && Number.isInteger(e.mode) &&
    [e.mtimeNs, e.atimeNs, e.ctimeNs, e.birthtimeNs].every((t) => typeof t === "string" && NS.test(t)) &&
    (e.linkTarget === undefined || typeof e.linkTarget === "string") &&
    Array.isArray(e.nameFixes);
}

/** The writer's instructions from a plan's `instructions`, or `undefined` when
 *  they are not the shape `plan()` writes. */
export function fromInstructions(value: unknown): PlanInternals | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const i = value as Record<string, unknown>;
  if (typeof i.policy !== "object" || i.policy === null || typeof i.overwrite !== "boolean" ||
    typeof i.timeZone !== "string" || (i.comment !== undefined && typeof i.comment !== "string") ||
    !Array.isArray(i.entries) || !i.entries.every(isEntry)) {
    return undefined;
  }
  const internals: PlanInternals = {
    policy: i.policy as ArchivePolicy,
    overwrite: i.overwrite,
    timeZone: i.timeZone,
    writeEntries: (i.entries as InstructionEntry[]).map((e): WriteEntry => {
      const entry: WriteEntry = {
        ...e,
        mtimeNs: BigInt(e.mtimeNs),
        atimeNs: BigInt(e.atimeNs),
        ctimeNs: BigInt(e.ctimeNs),
        birthtimeNs: BigInt(e.birthtimeNs),
      };
      return entry;
    }),
  };
  if (typeof i.comment === "string") internals.comment = i.comment;
  return internals;
}
