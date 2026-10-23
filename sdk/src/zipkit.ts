/**
 * The ZipKit SDK class. `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the heart of the SDK: a caller computes the
 * plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 *
 * Every method takes what it is asked to do as its arguments and one set of
 * call options (`ZipKitCallOptions`). Events go only to each call's `onEvent`
 * hook and progress to `onProgress`: the SDK writes no log file, reads no
 * environment variable, writes nothing outside the paths it is given, and
 * writes nothing to stdout or stderr. The caller records events wherever it
 * keeps its own. An instance emits one `session.start` event, with the version
 * and runtime configuration, to the first call that listens, before that
 * call's own events; a call that fails ends with one `fault` event. A failing
 * hook is deliberately silent so it cannot break a call.
 */

import os from "node:os";
import pLimit from "p-limit";
import { toAbortError, ZipKitError } from "./errors.ts";
import { matcherFor } from "./filter/match.ts";
import { reportFindings } from "./log/findings.ts";
import { createLogger, type Logger } from "./log/logger.ts";
import { recheckContent } from "./compare/content.ts";
import { compareWithManifest, explainRemoved, onDisk } from "./compare/sources.ts";
import { verifyArchive, type ManifestRecord } from "./read/verify.ts";
import { fromInstructions } from "./internal/instructions.ts";
import { pathKinds, pathState } from "./paths.ts";
import { checkRemoval, outputInsideInputs } from "./removal.ts";
import { pathResources, type PathResource } from "./claims.ts";
import { nodeFileSystem, Volume } from "./internal/volume.ts";
import { planArchive } from "./plan/plan.ts";
import { MANIFEST_DEFAULTS, resolvePolicy } from "./policy.ts";
import { scan } from "./scan/scan.ts";
import {
  validateChunkSize,
  validateConcurrency,
  validateIoTimeout,
  validatePolicy,
  validateDebug,
  requireAbsolute,
  requireAbsoluteList,
  validateCallOptions,
  validateApp,
  validateInstanceOptionKeys,
  validateRemovalRequest,
  validateSpec,
  validateVerifyRequest,
} from "./validate.ts";
import { writeArchive } from "./write/write.ts";
import { VERSION } from "./version.ts";
import type {
  ArchivePolicy,
  ArchiveSpec,
  PlanData,
  WriteData,
  DeepPartial,
  LogStage,
  SourceComparison,
  PathEntry,
  PathState,
  Program,
  ProgressCounts,
  RemovalCheck,
  RemovalRequest,
  VerifyData,
  VerifyRequest,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.ts";

export type { PlanData, WriteData } from "./types.ts";

/**
 * The default concurrency tracks the host's available parallelism (which
 * respects cgroup and CPU-affinity limits, so it does the right thing in CI and
 * containers), bounded at both ends. All streamed I/O is now chunked, so an
 * in-flight entry holds only about `chunkSize` of buffer rather than its whole
 * file; peak memory is therefore roughly `chunkSize × concurrency`. The cap
 * keeps a many-core box from opening an unbounded number of streams at once.
 * The floor keeps the work — which is largely I/O-bound — parallel even on a
 * single-vCPU container, where `availableParallelism()` returns 1. Concurrency
 * governs the scan and verification (each entry is read on its own); the
 * create write is a single ordered byte stream and runs sequentially.
 */
const MIN_DEFAULT_CONCURRENCY = 4;
const MAX_DEFAULT_CONCURRENCY = 16;

/** Default chunk size (64 KB) for all streamed I/O — see {@link ZipKitOptions.chunkSize}. */
const DEFAULT_CHUNK_SIZE = 65536;

/**
 * Default per-operation filesystem budget — see {@link ZipKitOptions.ioTimeoutMs}.
 * One operation moves at most a chunk, so on any working volume it settles in
 * well under a second; 30 s leaves room for a sleeping network drive or a disk
 * spinning up while still ending a job on a volume that has gone away.
 */
const DEFAULT_IO_TIMEOUT_MS = 30_000;

function defaultConcurrency(): number {
  return Math.max(MIN_DEFAULT_CONCURRENCY, Math.min(os.availableParallelism(), MAX_DEFAULT_CONCURRENCY));
}

export class ZipKit {
  readonly #policy: DeepPartial<ArchivePolicy> | undefined;
  readonly #app: Program | undefined;
  readonly #concurrency: number;
  readonly #chunkSize: number;
  readonly #ioTimeoutMs: number;
  /** Whether the once-per-instance startup event has been delivered yet. */
  #startupLogged = false;
  /** Whether `debug` events reach the hook. */
  readonly #debug: boolean;

  constructor(options: ZipKitOptions = {}) {
    validateInstanceOptionKeys(options);
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
    this.#app = options.app !== undefined ? validateApp(options.app) : undefined;
    this.#concurrency =
      options.concurrency !== undefined
        ? validateConcurrency(options.concurrency)
        : defaultConcurrency();
    this.#chunkSize =
      options.chunkSize !== undefined ? validateChunkSize(options.chunkSize) : DEFAULT_CHUNK_SIZE;
    this.#ioTimeoutMs =
      options.ioTimeoutMs !== undefined ? validateIoTimeout(options.ioTimeoutMs) : DEFAULT_IO_TIMEOUT_MS;
    this.#debug = validateDebug(options.debug);
  }

  /**
   * Scan and plan; writes nothing. Returns the `mode:"plan"` payload, plain
   * data that {@link ZipKit.write} takes as it is or after a structured clone
   * or JSON round trip, such as in another process.
   */
  async plan(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<PlanData> {
    return this.#run("plan", options, (run) => this.#plan(spec, run));
  }

  /** Execute a plan produced by {@link ZipKit.plan}, or a copy of one. A plan
   *  whose instructions are missing or malformed, or whose output, `writable`
   *  or Zip64 verdict disagree with them, fails with `plan.invalid`. An output
   *  that appeared since the plan, when replacing it was not authorized, is
   *  refused like a plan that blocks: the plan is returned unwritten, blocked
   *  by `output.exists`. */
  async write(plan: PlanData, options: ZipKitCallOptions = {}): Promise<WriteData | PlanData> {
    return this.#run("write", options, (run) => this.#write(plan, run));
  }

  /** Plan and write in one call. One logger and one signal serve both inner
   *  steps, so the caller's single `onEvent` hook sees the whole run and one
   *  cancellation stops it at whichever phase it is in. A plan that blocks,
   *  such as on an existing output without `overwrite`, is returned unwritten
   *  as the refusal, with the findings that block it. */
  async create(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<WriteData | PlanData> {
    return this.#run<WriteData | PlanData>("plan", options, async (run) => {
      const plan = await this.#plan(spec, run);
      if (!plan.writable) return plan;
      return this.#write(plan, run);
    });
  }

  /**
   * Verify an archive: read every entry through, checking its CRC-32 and its
   * local header, and under `manifest` hold the archive to its embedded
   * manifest and check each recorded SHA-256. Writes nothing. Without
   * `manifest` it is the archive's own integrity test and works on any ZIP.
   * What fails is reported in the result, not thrown: an error means the
   * check itself could not run.
   */
  async verify(request: VerifyRequest, options: ZipKitCallOptions = {}): Promise<VerifyData> {
    return this.#run("verify", options, (run) => {
      const { archive, manifest, manifestName } = validateVerifyRequest(request);
      return this.#verify(archive, manifest ?? false, this.#manifestName(manifestName), run);
    });
  }

  /** The manifest name a read looks for: the one given, else the instance
   *  policy's, else the default. */
  #manifestName(given: string | undefined): string {
    if (given !== undefined) return given;
    const manifest = resolvePolicy(this.#policy, undefined).manifest;
    return manifest !== false ? manifest.name : MANIFEST_DEFAULTS.name;
  }

  /**
   * Whether the originals an archive was made from can be removed without
   * losing data, checked in order: the archive does not sit at or inside an
   * input, it verifies against its manifest, and a fresh scan of the spec's
   * inputs still matches that manifest, every file and link by its content.
   * Reads the archive once and every original once, reporting how far through
   * `onProgress` (stage `verify`, then `recheck`). Removes nothing. A check
   * that cannot finish refuses, naming its step and carrying its error, and is
   * not a failure of the call; a cancellation is thrown.
   */
  async checkRemoval(request: RemovalRequest, options: ZipKitCallOptions = {}): Promise<RemovalCheck> {
    return this.#run("verify", options, async (run) => {
      const { spec, archive, removed = [] } = validateRemovalRequest(request);
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const manifestName = policy.manifest !== false ? policy.manifest.name : MANIFEST_DEFAULTS.name;
      // The archive is the output, so the fresh scan never counts the archive
      // itself when it sits beside the inputs.
      const { outputDir: _dir, outputName: _name, ...rest } = validated;
      const rescan: ArchiveSpec = { ...rest, output: archive };
      let records: ManifestRecord[] = [];
      const check = await checkRemoval({
        state: () => pathState(archive, run.volume),
        inside: () => outputInsideInputs(archive, validated.inputs, run.volume),
        verify: async () => {
          const data = await this.#verify(archive, true, manifestName, run, (kept) => { records = kept; });
          return { ok: data.ok, report: { summary: data.summary, missing: data.missing, extra: data.extra, findings: data.findings } };
        },
        compare: () => this.#compareSources(rescan, records, removed, run),
      }, archive);
      run.signal?.throwIfAborted();
      return check;
    });
  }

  /**
   * The SDK's bounded file access, for a caller that must touch the same user
   * volumes outside a verb (checking an input or an output location). Each call
   * is bounded by this instance's `ioTimeoutMs` and answers to `signal`, and
   * fails with a `io.stalled` error naming the path when the volume stops responding.
   */
  volume(signal?: AbortSignal): Volume {
    return new Volume(nodeFileSystem, this.#ioTimeoutMs, signal);
  }

  /**
   * What is at a path now: there with a fingerprint, missing, or out of reach on a
   * drive that is not connected or a path that cannot be read. Compare two
   * fingerprints with `sameFile` to tell a file rewritten in place from another
   * file put in its place. Bounded like every look at a user volume.
   */
  async pathState(target: string, options: ZipKitCallOptions = {}): Promise<PathState> {
    return this.#run("scan", options, (run) => pathState(requireAbsolute(target, "path"), run.volume));
  }

  /** Each path as a path claim compares it (see `createPathClaims`), resolved
   *  through links and folder aliases; a path that is a link to a file also
   *  yields the file it points to. Bounded like every look at a user volume. */
  async pathResources(paths: readonly string[], options: ZipKitCallOptions = {}): Promise<PathResource[]> {
    return this.#run("scan", options, (run) => pathResources(requireAbsoluteList(paths, "paths"), run.volume));
  }

  /** What each path is on disk now, in order (see `PathKind`). */
  async pathKinds(paths: readonly string[], options: ZipKitCallOptions = {}): Promise<PathEntry[]> {
    return this.#run("scan", options, (run) => pathKinds(requireAbsoluteList(paths, "paths"), run.volume, process.platform, this.#concurrency));
  }

  /**
   * The one seam every method runs through: checks the call options, builds
   * the call's logger on its `onEvent` hook and its bounded volume, runs the
   * method, classifies whatever it throws and records that as the call's one
   * `fault` event, and hands `onPhysicalSettlement` the volume's settlement.
   * `stage` is where a failure is recorded when its code names no domain.
   */
  async #run<U>(stage: LogStage, options: ZipKitCallOptions, fn: (run: Run) => Promise<U>): Promise<U> {
    validateCallOptions(options);
    const logger = createLogger(options.onEvent, this.#debug);
    // Startup event, once per instance, to the first call that listens: the
    // tool version and the effective runtime configuration, so a caller's
    // record is tied to a version and the knobs it ran with (the logging
    // convention's startup-coverage rule).
    if (!this.#startupLogged && options.onEvent) {
      this.#startupLogged = true;
      logger.emit({
        stage: "session",
        level: "info",
        event: "session.start",
        version: VERSION,
        concurrency: this.#concurrency,
        chunkSize: this.#chunkSize,
        ioTimeoutMs: this.#ioTimeoutMs,
        debug: this.#debug,
        policy: resolvePolicy(this.#policy, undefined),
      });
    }
    const volume = this.volume(options.signal);
    try {
      return await fn({ logger, volume, signal: options.signal, onProgress: options.onProgress });
    } catch (err) {
      const error = classified(err, options.signal);
      reportFault(logger, error, stage);
      throw error;
    } finally {
      // Capture after logical cleanup: an earlier empty set could report idle
      // before the first write, or omit continuations spawned by late calls.
      try { options.onPhysicalSettlement?.(volume.whenSettled()); }
      catch { /* Like the event hook, the observer cannot break the call. */ }
    }
  }

  /** The shared plan path of `plan()` and `create()`. */
  async #plan(spec: ArchiveSpec, run: Run): Promise<PlanData> {
    const validated = validateSpec(spec);
    const policy = resolvePolicy(this.#policy, validated.policy);
    const scanResult = await scan(validated, policy, {
      matcher: matcherFor(policy), limit: pLimit(this.#concurrency), logger: run.logger, signal: run.signal, volume: run.volume,
    });
    const plan = planArchive(scanResult, policy);
    reportPlan(run.logger, plan);
    return plan;
  }

  /** The shared write path of `write()` and `create()`. */
  #write(plan: PlanData, run: Run): Promise<WriteData | PlanData> {
    return writeArchive(plan, {
      logger: run.logger, chunkSize: this.#chunkSize, signal: run.signal, volume: run.volume, onProgress: run.onProgress, app: this.#app,
    });
  }

  /** The shared verification of `verify()` and `checkRemoval()`. */
  #verify(
    archive: string,
    manifest: boolean,
    manifestName: string,
    run: Run,
    keepRecords?: (records: ManifestRecord[]) => void,
  ): Promise<VerifyData> {
    return verifyArchive({ archive, manifest, manifestName }, {
      limit: pLimit(this.#concurrency),
      chunkSize: this.#chunkSize,
      logger: run.logger,
      signal: run.signal,
      volume: run.volume,
      onProgress: run.onProgress,
      ...(keepRecords ? { keepRecords } : {}),
    });
  }

  /**
   * Re-scan `spec`'s inputs and compare them with the archive's manifest
   * `records` (see {@link SourceComparison}), the last check before the
   * originals an archive was made from are removed. `spec` is the one the
   * archive was created with, so the same entries are included and excluded.
   * What inputs already removed (`removed`) took is not a difference. When
   * nothing was added, changed by type, size or time, or left unlisted, every
   * file and link is read again and compared by content. The answer names
   * places on disk. Writes nothing; emits the scan's events but not a plan's
   * findings, since this plan is never written.
   */
  async #compareSources(
    spec: ArchiveSpec,
    records: readonly ManifestRecord[],
    removed: readonly string[],
    run: Run,
  ): Promise<SourceComparison> {
    const policy = resolvePolicy(this.#policy, spec.policy);
    const limit = pLimit(this.#concurrency);
    const scanned = await scan(spec, policy, {
      matcher: matcherFor(policy), limit, logger: run.logger, signal: run.signal, volume: run.volume,
    });
    const plan = planArchive(scanned, policy);
    const unlistedDirs = new Set(scanned.unlistedDirs);
    const unlisted = scanned.entries.filter((e) => e.type === "dir" && unlistedDirs.has(e.archivePath));
    const fresh = fromInstructions(plan.instructions)?.writeEntries ?? [];
    // Where each source path was found now, for the answer.
    const diskPathOf = new Map(plan.entries.map((e) => [e.archivePath, e.diskPath]));
    const found = new Map<string, string[]>();
    const note = (sourcePath: string, diskPath: string | undefined): void => {
      if (diskPath === undefined) return;
      const list = found.get(sourcePath);
      if (list) list.push(diskPath);
      else found.set(sourcePath, [diskPath]);
    };
    for (const e of fresh) if (e.type !== "dir") note(e.sourcePath, diskPathOf.get(e.archivePath));
    for (const e of unlisted) note(e.sourcePath, e.diskPath);

    let comparison = explainRemoved(
      compareWithManifest(fresh, unlisted.map((e) => e.sourcePath), records), spec.inputs, removed);
    if (comparison.matches) {
      const changed = await recheckContent(fresh, records, {
        volume: run.volume, limit, chunkSize: this.#chunkSize, signal: run.signal, onProgress: run.onProgress,
      });
      if (changed.length > 0) comparison = { ...comparison, matches: false, changed };
    }
    return onDisk(comparison, found, spec.inputs, removed);
  }
}

/** What one call's work runs with: its logger, its bounded volume, its
 *  signal and its progress hook. */
interface Run {
  logger: Logger;
  volume: Volume;
  signal: AbortSignal | undefined;
  onProgress: ((counts: ProgressCounts) => void) | undefined;
}

/** Record a call's failure as its one `fault` event: the error as thrown,
 *  under the stage its code's domain names (a scan failure inside a plan is
 *  recorded under scan), else the call's own. A cancellation is no failure,
 *  so it is recorded at `info`. */
function reportFault(logger: Logger, error: ZipKitError, stage: LogStage): void {
  logger.emit({
    stage: STAGE_FOR_CODE_DOMAIN[error.code.split(".")[0]!] ?? stage,
    level: error.kind === "cancelled" ? "info" : "error",
    event: "fault",
    error: error.toJSON(),
  });
}

function reportPlan(logger: Logger, plan: PlanData): void {
  for (const entry of plan.entries) {
    if (entry.excluded) {
      logger.emit(
        entry.excludeReason !== undefined
          ? { stage: "plan", level: "debug", event: "entry.excluded", path: entry.archivePath, reason: entry.excludeReason }
          : { stage: "plan", level: "debug", event: "entry.excluded", path: entry.archivePath },
      );
    } else if (entry.archivePath !== entry.originalPath) {
      logger.emit({
        stage: "plan",
        level: "debug",
        event: "entry.renamed",
        path: entry.archivePath,
        from: entry.originalPath,
      });
    }
  }
  reportFindings(logger, "plan", plan.findings);
  logger.emit({
    stage: "plan",
    level: "info",
    event: "plan.done",
    total: plan.summary.total,
    included: plan.summary.included,
    excluded: plan.summary.excluded,
    renamed: plan.summary.renamed,
    warnings: plan.summary.warnings,
    errors: plan.summary.errors,
    writable: plan.writable,
  });
}

/** Every failure a verb reports is a ZipKitError: a cancellation as the
 *  cancelled error, and anything else that escapes as a gap in the SDK's own
 *  classification. */
function classified(err: unknown, signal: AbortSignal | undefined): ZipKitError {
  if (err instanceof ZipKitError) return err;
  if (signal?.aborted) return toAbortError(signal.reason);
  return new ZipKitError("internal.unexpected", err instanceof Error ? err.message : String(err), { cause: err });
}

/** The log stage of the domain an error code names; codes outside these
 *  domains (a policy, a stall, a cancellation) are recorded under the call's
 *  own stage. */
const STAGE_FOR_CODE_DOMAIN: Record<string, LogStage> = {
  scan: "scan",
  write: "write",
  archive: "verify",
  manifest: "verify",
};
