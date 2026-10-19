/**
 * The ZipKit SDK class. `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the heart of the SDK: a caller computes the
 * plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 *
 * Events go only to each call's `onEvent` hook and progress to `onProgress`:
 * the SDK writes no log file, reads no environment variable, writes nothing
 * outside the paths it is given, and writes nothing to stdout or stderr. The
 * caller records events wherever it keeps its own. An instance emits one
 * `session.start` event, with the version and runtime configuration, before
 * its first verb's events. A failing hook is deliberately silent so it cannot
 * break a verb.
 */

import os from "node:os";
import pLimit from "p-limit";
import { toAbortError, ZipKitError } from "./errors.ts";
import { matcherFor } from "./filter/match.ts";
import { reportFindings } from "./log/findings.ts";
import { createLogger, type LogSink } from "./log/logger.ts";
import type { Logger } from "./log/logger.ts";
import { recheckContent } from "./compare/content.ts";
import { compareWithManifest, explainRemoved, onDisk } from "./compare/sources.ts";
import { readManifestRecords, verifyArchive } from "./read/verify.ts";
import { fromInstructions } from "./internal/instructions.ts";
import { classifyPaths, pathState } from "./paths.ts";
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
  validateFlag,
  validateInstanceOptionKeys,
  validateManifestName,
  validateSpec,
} from "./validate.ts";
import { writeArchive, type WriteDeps } from "./write/write.ts";
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
  RemovalCheck,
  RemovalOptions,
  VerifyData,
  VerifyOptions,
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
  readonly #concurrency: number;
  readonly #chunkSize: number;
  readonly #ioTimeoutMs: number;
  /** Whether the once-per-instance startup event has been emitted yet. */
  #startupLogged = false;
  /** Whether `debug` events reach the sinks. */
  readonly #debug: boolean;

  constructor(options: ZipKitOptions = {}) {
    validateInstanceOptionKeys(options);
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
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
    return this.#run(options, (logger) => this.#plan(spec, logger, options.signal, this.volume(options.signal)));
  }

  /** Execute a plan produced by {@link ZipKit.plan}, or a copy of one. A plan
   *  whose instructions are missing or malformed fails with `plan.invalid`. */
  async write(plan: PlanData, options: ZipKitCallOptions = {}): Promise<WriteData> {
    const volume = this.volume(options.signal);
    try {
      return await this.#run(options, (logger) => this.#runWrite(plan, {
        logger, chunkSize: this.#chunkSize, signal: options.signal, volume, onProgress: options.onProgress,
      }));
    } finally { this.#notifySettlement(options, volume); }
  }

  /** Plan and write in one call. One logger and one signal serve both inner
   *  steps, so the caller's single `onEvent` hook sees the whole run and one
   *  cancellation stops it at whichever phase it is in. A plan that blocks,
   *  such as on an existing output without `overwrite`, is returned unwritten
   *  as the refusal, with the findings that block it. */
  async create(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<WriteData | PlanData> {
    const volume = this.volume(options.signal);
    try {
      return await this.#run<WriteData | PlanData>(options, async (logger) => {
        const plan = await this.#plan(spec, logger, options.signal, volume);
        if (!plan.writable) return plan;
        return this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal, volume, onProgress: options.onProgress });
      });
    } finally { this.#notifySettlement(options, volume); }
  }

  #notifySettlement(options: ZipKitCallOptions, volume: Volume): void {
    // Capture after logical cleanup: an earlier empty set could report idle
    // before the first write, or omit continuations spawned by late calls.
    try { options.onPhysicalSettlement?.(volume.whenSettled()); }
    catch { /* Like an event sink, the observer cannot break the verb. */ }
  }

  /**
   * Verify `archive`: read every entry through, checking its CRC-32 and its
   * local header, and under `manifest` hold the archive to its embedded
   * manifest and check each recorded SHA-256. Writes nothing. Without
   * `manifest` it is the archive's own integrity test and works on any ZIP.
   * What fails is reported in the result, not thrown: an error means the
   * check itself could not run.
   */
  async verify(archive: string, options: VerifyOptions = {}): Promise<VerifyData> {
    const { manifest, manifestName, ...call } = options;
    const volume = this.volume(call.signal);
    try {
      return await this.#run(call, async (logger) => {
        try {
          const request = {
            archive: requireAbsolute(archive, "archive"),
            manifest: validateFlag(manifest, "manifest") ?? false,
            manifestName: this.#manifestName(validateManifestName(manifestName)),
          };
          return await verifyArchive(request, {
            limit: pLimit(this.#concurrency),
            chunkSize: this.#chunkSize,
            logger,
            signal: call.signal,
            volume,
            onProgress: call.onProgress,
          });
        } catch (err) {
          this.#reportError(logger, err, "verify");
          throw err;
        }
      });
    } finally { this.#notifySettlement(call, volume); }
  }

  /** The manifest name a read looks for: the one given, else the instance
   *  policy's, else the default. */
  #manifestName(given: string | undefined): string {
    if (given !== undefined) return given;
    const manifest = resolvePolicy(this.#policy, undefined).manifest;
    return manifest !== false ? manifest.name : MANIFEST_DEFAULTS.name;
  }

  /**
   * Re-scan `spec`'s inputs and compare them with the manifest embedded in
   * `archive` (see {@link SourceComparison}), the last check before the
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
    archive: string,
    removed: readonly string[],
    options: ZipKitCallOptions,
  ): Promise<SourceComparison> {
    return this.#run(options, async (logger) => {
      try {
        const validated = validateSpec(spec);
        const policy = resolvePolicy(this.#policy, validated.policy);
        const volume = this.volume(options.signal);
        const limit = pLimit(this.#concurrency);
        const scanned = await scan(validated, policy, {
          matcher: matcherFor(policy),
          limit,
          logger,
          signal: options.signal,
          volume,
        });
        const plan = planArchive(scanned, policy);
        const name = policy.manifest !== false ? policy.manifest.name : MANIFEST_DEFAULTS.name;
        const records = await readManifestRecords(volume, archive, name, this.#chunkSize);
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
          compareWithManifest(fresh, unlisted.map((e) => e.sourcePath), records), validated.inputs, removed);
        if (comparison.matches) {
          const changed = await recheckContent(fresh, records, {
            volume, limit, chunkSize: this.#chunkSize, signal: options.signal, onProgress: options.onProgress,
          });
          if (changed.length > 0) comparison = { ...comparison, matches: false, changed };
        }
        return onDisk(comparison, found, validated.inputs, removed);
      } catch (err) {
        this.#reportError(logger, err);
        throw err;
      }
    });
  }

  /**
   * Whether the originals `archive` was made from can be removed without
   * losing data, checked in order: the archive does not sit at or inside an
   * input, it verifies against its manifest, and a fresh scan of `spec`'s
   * inputs still matches that manifest, every file and link by its content.
   * Reads every original once, reporting how far through `onProgress` (stage
   * `recheck`, after the verification's `verify`). `spec` is the one the archive was
   * created with, its inputs only those still to be removed; `removed` names
   * inputs an earlier partial removal already took. Removes nothing. A check
   * that cannot finish refuses, naming its step and carrying its error; a
   * cancellation is thrown.
   */
  async checkRemoval(spec: ArchiveSpec, archive: string, options: RemovalOptions = {}): Promise<RemovalCheck> {
    return this.#guard(options, async () => {
      const validated = validateSpec(spec);
      requireAbsolute(archive, "archive");
      const { removed: removedOption, ...call } = options;
      const removed = removedOption === undefined ? [] : requireAbsoluteList(removedOption, "removed");
      const manifest = resolvePolicy(this.#policy, validated.policy).manifest;
      // The archive is the output, so the fresh scan never counts the archive
      // itself when it sits beside the inputs.
      const { outputDir: _dir, outputName: _name, ...rest } = validated;
      const rescan: ArchiveSpec = { ...rest, output: archive };
      const check = await checkRemoval({
        state: () => this.pathState(archive, call),
        inside: () => outputInsideInputs(archive, validated.inputs, this.volume(call.signal)),
        verify: async () => {
          const data = await this.verify(archive, {
            ...call, manifest: true, ...(manifest !== false ? { manifestName: manifest.name } : {}),
          });
          return { ok: data.ok, report: { summary: data.summary, missing: data.missing, extra: data.extra, findings: data.findings } };
        },
        compare: () => this.#compareSources(rescan, archive, removed, call),
      }, archive);
      call.signal?.throwIfAborted();
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
  async pathState(target: string, options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathState> {
    return this.#guard(options, () => pathState(requireAbsolute(target, "path"), this.volume(options.signal)));
  }

  /** Each path as a path claim compares it (see `createPathClaims`), resolved
   *  through links and folder aliases; a path that is a link to a file also
   *  yields the file it points to. Bounded like every look at a user volume. */
  async pathResources(paths: readonly string[], options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathResource[]> {
    return this.#guard(options, () => pathResources(requireAbsoluteList(paths, "paths"), this.volume(options.signal)));
  }

  /** What each path is on disk now, in order (see `PathKind`). */
  async classify(paths: readonly string[], options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathEntry[]> {
    return this.#guard(options, () => classifyPaths(requireAbsoluteList(paths, "paths"), this.volume(options.signal)));
  }

  /**
   * The one seam every verb runs through: checks the call options, builds the
   * run's logger on the per-call `onEvent` hook, runs the verb and classifies
   * whatever it throws.
   */
  async #run<U>(options: ZipKitCallOptions, fn: (logger: Logger) => Promise<U>): Promise<U> {
    validateCallOptions(options);
    const sinks: LogSink[] = [];
    if (options.onEvent) sinks.push(options.onEvent);
    const logger = createLogger(sinks, this.#debug);
    // Startup event, once per instance: the tool version and the effective
    // runtime configuration, so a caller's record is tied to a version and the
    // knobs it ran with (the logging convention's startup-coverage rule).
    if (!this.#startupLogged) {
      this.#startupLogged = true;
      logger.emit({
        stage: "session",
        level: "info",
        event: "session.start",
        version: VERSION,
        concurrency: this.#concurrency,
        chunkSize: this.#chunkSize,
      });
    }
    try { return await fn(logger); }
    catch (err) { throw classified(err, options.signal); }
  }

  /** The seam for the methods that only look (a path's state, an archive's
   *  listing): the same option checks and error classification as `#run`,
   *  without a run's events or log. */
  async #guard<T>(options: object, fn: () => Promise<T>): Promise<T> {
    validateCallOptions(options);
    try { return await fn(); }
    catch (err) { throw classified(err, (options as ZipKitCallOptions).signal); }
  }

  /** The shared plan path. `plan()` and `create()` both route through it with
   *  the logger and signal from their own call's options. */
  async #plan(
    spec: ArchiveSpec,
    logger: Logger,
    signal: AbortSignal | undefined,
    volume: Volume,
  ): Promise<PlanData> {
    try {
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const matcher = matcherFor(policy);
      const limit = pLimit(this.#concurrency);

      const scanResult = await scan(validated, policy, { matcher, limit, logger, signal, volume });
      const plan = planArchive(scanResult, policy);
      this.#reportPlan(logger, plan);
      return plan;
    } catch (err) {
      this.#reportError(logger, err);
      throw err;
    }
  }

  /** Execute the writer, reporting any failure to the log stream before it
   *  propagates. `#plan()` reports its own failures, so `create()` does not
   *  double-report when its inner plan throws. */
  async #runWrite(
    plan: PlanData,
    deps: WriteDeps,
  ): Promise<WriteData> {
    try {
      return await writeArchive(plan, deps);
    } catch (err) {
      this.#reportError(deps.logger, err, "write");
      throw err;
    }
  }

  /** Emit a terminal error event so the `onEvent` hook records the failure
   *  instead of going silent mid-stream. Best-effort: the logger swallows its
   *  own faults, and the original error is always rethrown by the caller. The stage is the domain the error's code names (a scan
   *  failure inside a plan is recorded under scan), else the verb's own. */
  #reportError(logger: Logger, err: unknown, verbStage: LogStage = "plan"): void {
    const stage: LogStage = err instanceof ZipKitError ? STAGE_FOR_CODE_DOMAIN[err.code.split(".")[0]!] ?? verbStage : verbStage;
    const code = err instanceof ZipKitError ? err.code : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    logger.emit(
      cause !== undefined
        ? { stage, level: "error", event: "fault", code, detail: message, cause }
        : { stage, level: "error", event: "fault", code, detail: message },
    );
  }

  #reportPlan(logger: Logger, plan: PlanData): void {
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
 *  domains (a policy, a stall, a cancellation) are recorded under the verb's
 *  own stage. */
const STAGE_FOR_CODE_DOMAIN: Record<string, LogStage> = {
  scan: "scan",
  write: "write",
  archive: "verify",
  manifest: "verify",
};
