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

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { validatePolicy } from "../validate.ts";
import { resolvePolicy } from "../policy.ts";
import { isValidTimeZone } from "./timeZone.ts";
import { caseFold } from "./name-equivalence.ts";
import { RULE_REGISTRY } from "../registry.ts";
import { buildSummary } from "../plan/summary.ts";
import type { PlanData } from "../types.ts";
import type { ArchivePolicy, InstructionEntry, PlanInstructions } from "../types.ts";
import type { WriteEntry } from "./types.ts";

export interface PlanInternals {
  /** The archive's absolute path. */
  output: string;
  /** Whether nothing blocks the write. */
  writable: boolean;
  /** Whether the archive needs Zip64 structures, as the plan estimated. */
  zip64: boolean;
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
    output: internals.output,
    writable: internals.writable,
    zip64: internals.zip64,
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

const relative = z.string().min(1).refine(p => !p.includes("\u0000") && !p.startsWith("/") && !/^[A-Za-z]:\//.test(p) && p.split("/").every(s => s !== "" && s !== "." && s !== ".."));
// Source paths are original provenance: a literal colon remains valid here.
const sourceRelative = z.string().min(1).refine(p => !p.includes("\u0000") && !p.startsWith("/") && p.split("/").every(s => s !== "" && s !== "." && s !== ".."));
const absolute = z.string().refine(p => path.isAbsolute(p) && !p.includes("\u0000"));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Manifest ISO timestamps use this same nanoseconds-to-milliseconds conversion.
const ns = z.string().refine(t => /^-?\d+$/.test(t) && Number.isFinite(new Date(Number(BigInt(t) / 1_000_000n)).getTime()));
const rule = z.string().refine(r => Object.hasOwn(RULE_REGISTRY, r));
const fixes = z.array(z.strictObject({ rule: rule.refine(r => !r.startsWith("verify.")), before: z.string(), after: z.string() }));
const finding = z.strictObject({
  id: z.string(), rule, severity: z.enum(["info", "warning", "error"]), path: z.string(), message: z.string(),
  fix: z.strictObject({ kind: z.enum(["rename", "exclude", "normalize-attrs"]), to: z.string().optional() }).optional(),
});
const entrySchema = z.strictObject({
  archivePath: relative, originalPath: z.string().min(1), sourcePath: sourceRelative,
  absolutePath: z.string(), type: z.enum(["file", "dir", "symlink"]), method: z.enum(["store", "deflate"]),
  size: count, mode: z.number().int().min(0).max(0xffff),
  mtimeNs: ns, atimeNs: ns, ctimeNs: ns, birthtimeNs: ns,
  linkTarget: z.string().optional(), nameFixes: fixes,
}).refine(e => e.type === "dir" ? (e.absolutePath === "" || absolute.safeParse(e.absolutePath).success) && e.method === "store" && e.linkTarget === undefined
  : absolute.safeParse(e.absolutePath).success && (e.type === "symlink" ? e.method === "store" && typeof e.linkTarget === "string" && Buffer.byteLength(e.linkTarget, "utf8") === e.size : e.linkTarget === undefined));
const instructionsSchema = z.strictObject({
  output: absolute, writable: z.boolean(), zip64: z.boolean(), policy: z.unknown(), overwrite: z.boolean(),
  timeZone: z.string().refine(isValidTimeZone), comment: z.string().refine(c => Buffer.byteLength(c, "utf8") <= 0xffff).optional(),
  entries: z.array(entrySchema),
});

/** Decode only the complete resolved instructions produced by the planner. */
export function fromInstructions(value: unknown): PlanInternals | undefined {
  const parsed = instructionsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const i = parsed.data;
  let policy: ArchivePolicy;
  try {
    policy = resolvePolicy(undefined, validatePolicy(i.policy as ArchivePolicy));
  } catch { return undefined; }
  if (!isDeepStrictEqual(policy, i.policy)) return undefined;
  const paths = new Set<string>();
  const reserved = policy.manifest === false ? undefined : caseFold(policy.manifest.name);
  for (const e of i.entries) {
    const folded = caseFold(e.archivePath);
    if (i.writable && (paths.has(folded) || folded === reserved)) return undefined;
    paths.add(folded);
  }
  const { entries, ...rest } = i;
  return {
    ...rest, policy,
    writeEntries: entries.map(e => ({ ...e, nameFixes: e.nameFixes as InstructionEntry["nameFixes"],
      mtimeNs: BigInt(e.mtimeNs), atimeNs: BigInt(e.atimeNs), ctimeNs: BigInt(e.ctimeNs), birthtimeNs: BigInt(e.birthtimeNs) })),
  };
}

const visibleSchema = z.strictObject({
  mode: z.literal("plan"), output: absolute, writable: z.boolean(), findings: z.array(finding),
  instructions: z.unknown(),
  summary: z.strictObject({ total: count, included: count, excluded: count, renamed: count, warnings: count, errors: count, zip64: z.boolean(), sourceBytes: count }),
  entries: z.array(z.strictObject({ archivePath: z.string(), originalPath: z.string(), diskPath: absolute,
    type: z.enum(["file", "dir"]), method: z.enum(["store", "deflate"]), excluded: z.boolean(), nameFixes: fixes, findings: z.array(finding),
    excludeCode: z.enum(["pattern", "empty-file", "empty-dir", "symlink", "duplicate", "path-traversal", "unsupported"]).optional(),
    excludeReason: z.string().optional(),
    unsupportedKind: z.enum(["socket", "fifo", "device", "broken-link", "external-link", "unreadable-link"]).optional(),
    excludedBy: z.strictObject({ id: z.string().optional(), pattern: z.string() }).optional(),
  }).refine(e => e.excluded === (e.excludeCode !== undefined) && e.excluded === (e.excludeReason !== undefined) &&
    (e.unsupportedKind !== undefined) === (e.excludeCode === "unsupported") && (e.excludedBy !== undefined) === (e.excludeCode === "pattern"))),
});

/** Validate the reviewed report against the instructions without scanning or
 *  deciding again. Every included entry has its own write instruction.
 *  diskPath is lexical and absolutePath may be a followed link's target. The
 *  mutable plain-data handoff proves their shapes, not source authenticity;
 *  filesystem identity/content checks belong to the write edge. */
export function fromPlan(value: unknown): PlanInternals | undefined {
  const parsed = visibleSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  const i = fromInstructions((value as PlanData).instructions);
  if (!i || p.output !== i.output || p.writable !== i.writable || p.summary.zip64 !== i.zip64) return undefined;
  const included = p.entries.filter(e => !e.excluded);
  if (included.length !== i.writeEntries.length) return undefined;
  for (let n = 0; n < included.length; n++) {
    const v = included[n]!, e = i.writeEntries[n]!;
    if (v.archivePath !== e.archivePath || v.originalPath !== e.originalPath || v.type !== (e.type === "dir" ? "dir" : "file") || v.method !== e.method || !isDeepStrictEqual(v.nameFixes, e.nameFixes)) return undefined;
  }
  const findingsById = new Map<string, typeof p.findings>();
  for (const f of p.findings) {
    const group = findingsById.get(f.id);
    if (group) group.push(f);
    else findingsById.set(f.id, [f]);
  }
  for (const e of p.entries) for (const f of e.findings) {
    const group = findingsById.get(f.id);
    const match = group?.findIndex(g => isDeepStrictEqual(g, f)) ?? -1;
    if (match < 0) return undefined;
    group!.splice(match, 1);
  }
  // The summary the planner would have built from these entries and findings.
  if (!isDeepStrictEqual(p.summary, buildSummary(p.entries, p.findings, i.zip64, i.writeEntries)) || p.writable !== (p.summary.errors === 0)) return undefined;
  return i;
}
